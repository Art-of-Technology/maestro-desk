import { getDb } from './db.js';
import { extractKnowledge } from './knowledge-import.js';
import { contentHash } from './knowledge-sources.js';
import { attachmentsStore, contentDispositionFor } from './r2.js';
import { enqueueObjectDeletions } from './object-outbox.js';
import { assertKnowledgeMarket } from './knowledge-market-policy.js';

export async function replaceKnowledgeFile(workspaceId: string, id: string, filename: string, bytes: Uint8Array) {
  const sql = getDb();
  // postgres.js serializes timestamp parameters at JavaScript's millisecond precision.
  const [source] = await sql`update knowledge_sources set lease_until=date_trunc('milliseconds',now())+interval '3 minutes'
    where id=${id} and workspace_id=${workspaceId} and kind='file'
    and (lease_until is null or lease_until<now()) returning *,lease_until::text as lease_token`;
  if (!source) {
    const [exists] = await sql`select id from knowledge_sources where id=${id} and workspace_id=${workspaceId} and kind='file'`;
    return { status: exists ? 'busy' : 'missing' } as const;
  }
  let newKey: string | undefined;
  let committed = false;
  try {
    assertKnowledgeMarket(workspaceId, source);
    const fingerprint = contentHash(`file:${contentHash(bytes)}:${source.language}:${source.jurisdiction}`);
    if (fingerprint === source.fingerprint && source.latest_version_id)
      return { status: 'ok', duplicate: true } as const;

    const extracted = await extractKnowledge(bytes, filename.split('.').pop()!.toLowerCase());
    assertKnowledgeMarket(workspaceId, { ...source, body: extracted.body });
    newKey = `knowledge/${workspaceId}/${id}/${crypto.randomUUID()}/${filename}`;
    await attachmentsStore().putObject(newKey, bytes, {
      contentType: 'application/octet-stream',
      contentDisposition: contentDispositionFor('attachment', filename),
    });
    const key = newKey;
    const result = await sql.begin(async (tx) => {
      // Match new uploads' lock order so duplicate checks and source updates are atomic.
      await tx`select id from workspaces where id=${workspaceId} for update`;
      const [current] = await tx`select id from knowledge_sources
        where id=${id} and workspace_id=${workspaceId} and kind='file'
        and lease_until=${source.lease_token}::timestamptz and lease_until>now()
        and storage_key is not distinct from ${source.storage_key} for update`;
      if (!current) return 'busy' as const;
      const [duplicate] = await tx`select id from knowledge_sources
        where workspace_id=${workspaceId} and fingerprint=${fingerprint} and id<>${id}`;
      if (duplicate) return 'duplicate' as const;
      const [version] = await tx`insert into knowledge_source_versions(workspace_id,source_id,content_hash,body,warnings)
        values(${workspaceId},${id},${contentHash(extracted.body)},${extracted.body},${tx.json(extracted.warnings)})
        on conflict(source_id,content_hash) do update set content_hash=excluded.content_hash returning id`;
      await tx`update knowledge_sources set storage_key=${key},locator=${filename},fingerprint=${fingerprint},
        latest_version_id=${version.id},checked_at=now(),error=null,lease_until=null
        where id=${id} and workspace_id=${workspaceId}`;
      if (source.storage_key) await enqueueObjectDeletions(tx, [source.storage_key], 'orphan');
      return 'ok' as const;
    });
    committed = result === 'ok';
    return { status: result, duplicate: false };
  } finally {
    if (!committed) {
      // Failed or superseded work must never clear a newer operation's lease.
      await sql.begin(async (tx) => {
        await tx`select id from workspaces where id=${workspaceId} for update`;
        await tx`update knowledge_sources set lease_until=null
          where id=${id} and workspace_id=${workspaceId} and lease_until=${source.lease_token}::timestamptz`;
        if (newKey) {
          // A dropped connection can make a successful COMMIT look like a failure.
          const [live] = await tx`select id from knowledge_sources where workspace_id=${workspaceId} and storage_key=${newKey}`;
          if (!live) await enqueueObjectDeletions(tx, [newKey], 'orphan');
        }
      });
    }
  }
}
