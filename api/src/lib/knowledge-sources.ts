import { createHash } from 'node:crypto';
import { getDb } from './db.js';
import {
  extractKnowledge,
  publicKnowledgeError,
  type Extracted,
} from './knowledge-import.js';
import { attachmentsStore } from './r2.js';

export const contentHash = (text: string | Uint8Array) =>
  createHash('sha256').update(text).digest('hex');
export async function saveKnowledgeVersion(
  workspaceId: string,
  sourceId: string,
  extracted: Extracted,
) {
  const sql = getDb();
  await sql.begin(async (tx) => {
    const [source] =
      await tx`select id from knowledge_sources where id=${sourceId} and workspace_id=${workspaceId} for update`;
    if (!source) throw new Error('Source was removed.');
    const [version] =
      await tx`insert into knowledge_source_versions(workspace_id,source_id,content_hash,body,warnings)
      values(${workspaceId},${sourceId},${contentHash(extracted.body)},${extracted.body},${tx.json(extracted.warnings)})
      on conflict(source_id,content_hash) do update set content_hash=excluded.content_hash returning id`;
    await tx`update knowledge_sources set latest_version_id=${version.id},checked_at=now(), next_check_at=now()+interval '1 hour',error=null,lease_until=null
      where id=${sourceId} and workspace_id=${workspaceId}`;
  });
}
export async function refreshKnowledgeSource(workspaceId: string, id: string): Promise<boolean> {
  const sql = getDb();
  const [s] = await sql`update knowledge_sources set lease_until=now()+interval '3 minutes'
    where id=${id} and workspace_id=${workspaceId} and kind='file' and (lease_until is null or lease_until<now()) returning *`;
  if (!s) return false;
  try {
    const bytes = (await attachmentsStore().getObject(s.storage_key)).bytes;
    const extension = String(s.locator).split('.').pop()!.toLowerCase();
    await saveKnowledgeVersion(workspaceId, id, await extractKnowledge(bytes, extension));
  } catch (error) {
    // Never return raw upstream/parser details containing signed URLs or internal paths.
    const message = publicKnowledgeError(error);
    await sql`update knowledge_sources set error=${message},
      next_check_at=now()+interval '1 hour',lease_until=null where id=${id} and workspace_id=${workspaceId}`;
    throw new Error(message);
  }
  return true;
}
export async function refreshDueKnowledgeSources() {
  // Keep existing scheduler calls compatible while automatic imports are disabled.
  // Preserve historical sources and their settings without making network requests.
  return { processed: 0, failed: 0 };
}
