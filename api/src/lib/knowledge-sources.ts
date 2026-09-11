import { createHash } from 'node:crypto';
import { getDb } from './db.js';
import { extractKnowledge, fetchKnowledgePage, type Extracted } from './knowledge-import.js';
import { attachmentsStore } from './r2.js';

export const contentHash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
export async function saveKnowledgeVersion(workspaceId: string, sourceId: string, extracted: Extracted) {
  const sql=getDb();
  await sql.begin(async tx => {
    const [source]=await tx`select id from knowledge_sources where id=${sourceId} and workspace_id=${workspaceId} for update`;
    if (!source) throw new Error('Source was removed.');
    const [version]=await tx`insert into knowledge_source_versions(workspace_id,source_id,content_hash,body,warnings)
      values(${workspaceId},${sourceId},${contentHash(extracted.body)},${extracted.body},${tx.json(extracted.warnings)})
      on conflict(source_id,content_hash) do update set content_hash=excluded.content_hash returning id`;
    await tx`update knowledge_sources set latest_version_id=${version.id},checked_at=now(), next_check_at=now()+interval '1 hour',error=null,lease_until=null
      where id=${sourceId} and workspace_id=${workspaceId}`;
  });
}
export async function refreshKnowledgeSource(workspaceId: string, id: string): Promise<boolean> {
  const sql=getDb();
  const [s]=await sql`update knowledge_sources set lease_until=now()+interval '3 minutes'
    where id=${id} and workspace_id=${workspaceId} and (lease_until is null or lease_until<now()) returning *`;
  if (!s) return false;
  try {
    const bytes=s.kind==='url' ? await fetchKnowledgePage(s.locator) : (await attachmentsStore().getObject(s.storage_key)).bytes;
    const extension=s.kind==='url'?'html':String(s.locator).split('.').pop()!.toLowerCase();
    await saveKnowledgeVersion(workspaceId,id,await extractKnowledge(bytes,extension));
  } catch {
    // Never return raw upstream/parser details containing signed URLs or internal paths.
    await sql`update knowledge_sources set error='Could not read the source. Check the URL or file and try again.',
      next_check_at=now()+interval '1 hour',lease_until=null where id=${id} and workspace_id=${workspaceId}`;
    throw new Error('Could not read the source. Check the URL or file and try again.');
  }
  return true;
}
export async function refreshDueKnowledgeSources() {
  const sql=getDb();
  const rows=await sql`select id,workspace_id from knowledge_sources where kind='url' and auto_refresh
    and (next_check_at is null or next_check_at<=now()) and (lease_until is null or lease_until<now()) order by next_check_at nulls first limit 10`;
  let processed=0, failed=0;
  // Bounded concurrency; request is well below the edge timeout for ordinary HTML pages.
  await Promise.all(rows.map(async s => {try {if(await refreshKnowledgeSource(s.workspace_id,s.id)) processed++;} catch {failed++;}}));
  return {processed,failed};
}
