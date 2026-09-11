import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { getDb } from '../lib/db.js';
import {
  canonicalKnowledgeUrl,
  MAX_KNOWLEDGE_BYTES,
  publicKnowledgeError,
} from '../lib/knowledge-import.js';
import { contentHash, refreshKnowledgeSource } from '../lib/knowledge-sources.js';
import { attachmentsStore, contentDispositionFor } from '../lib/r2.js';
import { enforceRateLimit } from '../lib/rate-limit.js';
import { enqueueObjectDeletions } from '../lib/object-outbox.js';

export const knowledgeSources = new Hono();
knowledgeSources.use('*', requireAuth);
knowledgeSources.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
knowledgeSources.use('*', async (c, next) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  await next();
});
knowledgeSources.use(
  '*',
  bodyLimit({
    maxSize: MAX_KNOWLEDGE_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: 'Choose a file up to 20 MB.' }, 413),
  }),
);
knowledgeSources.use('*', async (c, next) => {
  if (c.req.method === 'POST') {
    const denied = await enforceRateLimit(c, {
      name: 'knowledge-import',
      by: c.get('workspaceId'),
      max: 6,
      windowSeconds: 60,
      failClosed: true,
    });
    if (denied) return denied;
  }
  await next();
});
const Metadata = z.object({
  title: z.string().trim().min(1).max(300),
  category: z.string().trim().min(1).max(100),
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(-[A-Za-z]{2,8})?$/),
  jurisdiction: z.string().trim().max(100),
});

knowledgeSources.get('/', async (c) => {
  const sources =
    await getDb()`select s.*, v.id as latest_version_id, v.content_hash, v.created_at as version_at,
    (v.id is distinct from s.approved_version_id) as needs_review
    from knowledge_sources s left join knowledge_source_versions v on v.id=s.latest_version_id and v.workspace_id=s.workspace_id
    where s.workspace_id=${c.get('workspaceId')} order by s.created_at desc`;
  return c.json({ sources });
});
knowledgeSources.get('/:id', async (c) => {
  const sql = getDb(),
    ws = c.get('workspaceId');
  if (!z.string().uuid().safeParse(c.req.param('id')).success)
    return c.json({ error: 'Source not found' }, 404);
  const [source] =
    await sql`select * from knowledge_sources where id=${c.req.param('id')} and workspace_id=${ws}`;
  if (!source) return c.json({ error: 'Source not found' }, 404);
  const versions =
    await sql`select * from knowledge_source_versions where source_id=${source.id} and workspace_id=${ws}
    and (id in (select id from knowledge_source_versions where source_id=${source.id} and workspace_id=${ws} order by created_at desc,id desc limit 50)
      or id=${source.approved_version_id} or id=${source.latest_version_id}) order by created_at desc,id desc`;
  return c.json({ source, versions });
});
knowledgeSources.post('/', async (c) => {
  const ws = c.get('workspaceId'),
    sql = getDb();
  let metadata: z.infer<typeof Metadata>,
    locator: string,
    kind: 'file' | 'url',
    bytes: Uint8Array | undefined,
    auto = false;
  try {
    if ((c.req.header('content-type') || '').startsWith('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string' || !file.size || file.size > MAX_KNOWLEDGE_BYTES)
        throw new Error('Choose a file up to 20 MB.');
      metadata = Metadata.parse({
        title: form.get('title'),
        category: form.get('category'),
        language: form.get('language'),
        jurisdiction: form.get('jurisdiction') || '',
      });
      locator = file.name
        .replace(/^.*[\\/]/, '')
        .replace(/[\x00-\x1f]/g, '')
        .slice(0, 200);
      if (!/\.(pdf|docx|pptx|png|jpg|jpeg|webp)$/i.test(locator))
        throw new Error('Use PNG, JPEG, WebP, PDF, DOCX or PPTX.');
      kind = 'file';
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      const input = z
        .object({
          ...Metadata.shape,
          url: z.string().max(2048),
          auto_refresh: z.boolean().default(true),
        })
        .strict()
        .parse(await c.req.json());
      metadata = input;
      locator = canonicalKnowledgeUrl(input.url);
      kind = 'url';
      auto = input.auto_refresh;
    }
  } catch {
    return c.json(
      {
        error:
          'Check the title, category, language and public HTTPS URL, or choose a supported file up to 20 MB.',
      },
      400,
    );
  }
  const id = crypto.randomUUID(),
    fingerprint = contentHash(
      `${kind}:${kind === 'url' ? locator : contentHash(bytes!)}:${metadata.language}:${metadata.jurisdiction}`,
    );
  const key = kind === 'file' ? `knowledge/${ws}/${id}/${locator}` : null;
  // Serialize the per-workspace cap and duplicate check, including concurrent uploads.
  const source = await sql.begin(async (tx) => {
    await tx`select id from workspaces where id=${ws} for update`;
    const [existing] =
      await tx`select * from knowledge_sources where workspace_id=${ws} and fingerprint=${fingerprint}`;
    if (existing) return existing;
    const [count] =
      await tx`select count(*)::int as n from knowledge_sources where workspace_id=${ws}`;
    if (count.n >= 100) return null;
    const [s] =
      await tx`insert into knowledge_sources(id,workspace_id,kind,title,category,language,jurisdiction,locator,fingerprint,storage_key,auto_refresh,created_by,lease_until)
      values(${id},${ws},${kind},${metadata.title},${metadata.category},${metadata.language},${metadata.jurisdiction},${locator},${fingerprint},${key},${auto},${c.get('userId')},now()+interval '3 minutes') returning *`;
    return s;
  });
  if (!source)
    return c.json({ error: 'This workspace has reached its limit of 100 knowledge sources.' }, 409);
  if (source.id !== id) return c.json({ source, duplicate: true });
  let stored = !key;
  try {
    if (bytes && key) {
      await attachmentsStore().putObject(key, bytes, {
        contentType: 'application/octet-stream',
        contentDisposition: contentDispositionFor('attachment', locator),
      });
      stored = true;
    }
    await sql`update knowledge_sources set lease_until=null where id=${id} and workspace_id=${ws}`;
    await refreshKnowledgeSource(ws, id);
    return c.json({ source: { ...source, lease_until: null } }, 201);
  } catch (error) {
    if (!stored) {
      await sql`delete from knowledge_sources where id=${id} and workspace_id=${ws}`;
      // A timed-out PUT may still have reached storage. Queue cleanup even if
      // a concurrent workspace deletion already removed the source row.
      if (key) await enqueueObjectDeletions(sql, [key], 'orphan');
      return c.json({ error: 'The file could not be stored. Try the upload again.' }, 502);
    }
    const message = publicKnowledgeError(error);
    const [present] =
      await sql`select id from knowledge_sources where id=${id} and workspace_id=${ws}`;
    if (!present && key) await enqueueObjectDeletions(sql, [key], 'orphan');
    await sql`update knowledge_sources set error=${message},lease_until=null
      where id=${id} and workspace_id=${ws}`;
    return c.json({ source: { ...source, error: message } }, 201);
  }
});
knowledgeSources.post('/:id/refresh', async (c) => {
  const id = c.req.param('id');
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Source not found' }, 404);
  try {
    return c.json({ refreshed: await refreshKnowledgeSource(c.get('workspaceId'), id) });
  } catch (error) {
    return c.json(
      { error: publicKnowledgeError(error) + ' The last published version is unchanged.' },
      422,
    );
  }
});
knowledgeSources.patch('/:id', async (c) => {
  const id = c.req.param('id');
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Source not found' }, 404);
  const input = z
    .object({ auto_refresh: z.boolean() })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Choose whether to refresh automatically.' }, 400);
  const [source] =
    await getDb()`update knowledge_sources set auto_refresh=${input.data.auto_refresh},next_check_at=now()
    where id=${id} and workspace_id=${c.get('workspaceId')} and kind='url' returning id`;
  return source ? c.json({ ok: true }) : c.json({ error: 'Website source not found' }, 404);
});
knowledgeSources.post('/:id/publish', async (c) => {
  const id = c.req.param('id'),
    ws = c.get('workspaceId'),
    sql = getDb();
  const input = z
    .object({ version_id: z.string().uuid() })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!z.string().uuid().safeParse(id).success || !input.success)
    return c.json({ error: 'Choose a source version.' }, 400);
  const result = await sql.begin(async (tx) => {
    const [s] =
      await tx`select * from knowledge_sources where id=${id} and workspace_id=${ws} for update`;
    if (!s) return null;
    const [v] =
      await tx`select * from knowledge_source_versions where id=${input.data.version_id} and source_id=${id} and workspace_id=${ws}`;
    if (!v) return null;
    // Explicit version selection supports both approving an update and rolling back.
    const body = `Source: ${s.title}\nLanguage: ${s.language}\nJurisdiction: ${s.jurisdiction || 'Not specified'}\n${s.kind === 'url' ? `URL: ${s.locator}\n` : ''}Imported: ${new Date(v.created_at).toISOString()}\n\n${v.body}`;
    let articleId = s.article_id;
    if (articleId)
      await tx`update kb_articles set title=${s.title},category=${s.category},body=${body},status='published',updated_at=now() where id=${articleId} and workspace_id=${ws}`;
    else {
      const [a] =
        await tx`insert into kb_articles(workspace_id,display_id,title,category,body,status,author_user_id)
        values(${ws},${'KB-' + crypto.randomUUID().slice(0, 8)},${s.title},${s.category},${body},'published',${c.get('userId')}) returning id`;
      articleId = a.id;
    }
    await tx`update knowledge_sources set article_id=${articleId},approved_version_id=${v.id} where id=${id} and workspace_id=${ws}`;
    await tx`update knowledge_source_versions set approved_at=now(),approved_by=${c.get('userId')} where id=${v.id} and workspace_id=${ws}`;
    return articleId;
  });
  return result
    ? c.json({ article_id: result })
    : c.json({ error: 'Source version not found' }, 404);
});
knowledgeSources.get('/:id/download', async (c) => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success)
    return c.json({ error: 'File not found' }, 404);
  const [s] =
    await getDb()`select storage_key from knowledge_sources where id=${c.req.param('id')} and workspace_id=${c.get('workspaceId')} and kind='file'`;
  return s?.storage_key
    ? c.json({ url: await attachmentsStore().presignGet(s.storage_key, { expiresSeconds: 300 }) })
    : c.json({ error: 'File not found' }, 404);
});
knowledgeSources.delete('/:id', async (c) => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success)
    return c.json({ error: 'Source not found' }, 404);
  const ws = c.get('workspaceId');
  const removed = await getDb().begin(async (tx) => {
    const [s] =
      await tx`select * from knowledge_sources where id=${c.req.param('id')} and workspace_id=${ws} for update`;
    if (!s) return true;
    if (s.lease_until && new Date(s.lease_until).getTime() > Date.now()) return false;
    if (s.article_id)
      await tx`delete from kb_articles where id=${s.article_id} and workspace_id=${ws}`;
    await tx`delete from knowledge_sources where id=${s.id} and workspace_id=${ws}`;
    return true;
  });
  return removed
    ? c.body(null, 204)
    : c.json(
        { error: 'This source is being imported. Wait for it to finish before removing it.' },
        409,
      );
});
