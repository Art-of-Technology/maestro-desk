import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';

// Email branding: brand header/footer templates (workspace-scoped, admin-
// managed) + per-sender signatures (each agent manages their own). Consumed by
// lib/email-branding.ts at send time. Authorization is API middleware: every
// query filters by workspace_id (templates) or workspace_id + user_id
// (signatures) — there is no DB-level backstop.
export const emailBranding = new Hono();

emailBranding.use('*', requireAuth);

const TEMPLATE_COLS = `id, name, header_text, footer_text, show_logo, is_default, created_at, updated_at`;
const SIG_COLS = `id, name, body_text, is_default, created_at, updated_at`;

// The UI captures plain text only; *_html columns are reserved for a future
// raw-HTML authoring mode (lib/email-branding derives safe HTML from the text).
const TemplateBody = z.object({
  name:        z.string().min(1).max(120),
  header_text: z.string().max(2000).nullable().optional(),
  footer_text: z.string().max(2000).nullable().optional(),
  show_logo:   z.boolean().optional(),
  is_default:  z.boolean().optional(),
}).strict();

const TemplatePatch = z.object({
  name:        z.string().min(1).max(120).optional(),
  header_text: z.string().max(2000).nullable().optional(),
  footer_text: z.string().max(2000).nullable().optional(),
  show_logo:   z.boolean().optional(),
}).strict();

const SigBody = z.object({
  name:       z.string().min(1).max(120),
  body_text:  z.string().max(2000).nullable().optional(),
  is_default: z.boolean().optional(),
}).strict();

const SigPatch = z.object({
  name:      z.string().min(1).max(120).optional(),
  body_text: z.string().max(2000).nullable().optional(),
}).strict();

// ─── Brand templates (admin) ─────────────────────────────────────────────

// GET /templates — list, any workspace member (read-only).
emailBranding.get('/templates', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const rows = await sql`
    select ${sql.unsafe(TEMPLATE_COLS)} from email_brand_templates
    where workspace_id = ${workspaceId} and deleted_at is null
    order by is_default desc, created_at asc
  `;
  return c.json({ templates: rows });
});

// POST /templates — admin create. If is_default, clears the previous default.
emailBranding.post('/templates', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const parsed = TemplateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const d = parsed.data;

  const row = await sql.begin(async (tx) => {
    if (d.is_default) {
      await tx`
        update email_brand_templates set is_default = false, updated_at = now()
        where workspace_id = ${workspaceId} and is_default = true and deleted_at is null
      `;
    }
    const [created] = await tx`
      insert into email_brand_templates (workspace_id, name, header_text, footer_text, show_logo, is_default)
      values (${workspaceId}, ${d.name}, ${d.header_text ?? null}, ${d.footer_text ?? null},
              ${d.show_logo ?? true}, ${d.is_default ?? false})
      returning ${tx.unsafe(TEMPLATE_COLS)}
    `;
    return created;
  });
  return c.json({ template: row }, 201);
});

// PATCH /templates/:id — admin edit (not is_default; use /default for that).
emailBranding.patch('/templates/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  const parsed = TemplatePatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  const [row] = await sql`
    update email_brand_templates set ${sql(parsed.data)}, updated_at = now()
    where id = ${id} and workspace_id = ${workspaceId} and deleted_at is null
    returning ${sql.unsafe(TEMPLATE_COLS)}
  `;
  if (!row) return c.json({ error: 'Template not found' }, 404);
  return c.json({ template: row });
});

// POST /templates/:id/default — admin; make this the workspace default.
emailBranding.post('/templates/:id/default', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const row = await sql.begin(async (tx) => {
    await tx`
      update email_brand_templates set is_default = false, updated_at = now()
      where workspace_id = ${workspaceId} and is_default = true and deleted_at is null
    `;
    const [updated] = await tx`
      update email_brand_templates set is_default = true, updated_at = now()
      where id = ${id} and workspace_id = ${workspaceId} and deleted_at is null
      returning ${tx.unsafe(TEMPLATE_COLS)}
    `;
    return updated;
  });
  if (!row) return c.json({ error: 'Template not found' }, 404);
  return c.json({ template: row });
});

// DELETE /templates/:id — admin soft-delete.
emailBranding.delete('/templates/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  const [row] = await sql`
    update email_brand_templates set deleted_at = now(), is_default = false, updated_at = now()
    where id = ${id} and workspace_id = ${workspaceId} and deleted_at is null
    returning id
  `;
  if (!row) return c.json({ error: 'Template not found' }, 404);
  return c.json({ ok: true });
});

// ─── Signatures (per-agent; each user manages their own) ──────────────────

// GET /signatures — the caller's own signatures.
emailBranding.get('/signatures', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const rows = await sql`
    select ${sql.unsafe(SIG_COLS)} from email_signatures
    where workspace_id = ${workspaceId} and user_id = ${userId} and deleted_at is null
    order by is_default desc, created_at asc
  `;
  return c.json({ signatures: rows });
});

// POST /signatures — create one of the caller's own signatures.
emailBranding.post('/signatures', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const parsed = SigBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const d = parsed.data;

  const row = await sql.begin(async (tx) => {
    if (d.is_default) {
      await tx`
        update email_signatures set is_default = false, updated_at = now()
        where workspace_id = ${workspaceId} and user_id = ${userId} and is_default = true and deleted_at is null
      `;
    }
    const [created] = await tx`
      insert into email_signatures (workspace_id, user_id, name, body_text, is_default)
      values (${workspaceId}, ${userId}, ${d.name}, ${d.body_text ?? null}, ${d.is_default ?? false})
      returning ${tx.unsafe(SIG_COLS)}
    `;
    return created;
  });
  return c.json({ signature: row }, 201);
});

// PATCH /signatures/:id — edit one of the caller's own signatures.
emailBranding.patch('/signatures/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const parsed = SigPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  const [row] = await sql`
    update email_signatures set ${sql(parsed.data)}, updated_at = now()
    where id = ${id} and workspace_id = ${workspaceId} and user_id = ${userId} and deleted_at is null
    returning ${sql.unsafe(SIG_COLS)}
  `;
  if (!row) return c.json({ error: 'Signature not found' }, 404);
  return c.json({ signature: row });
});

// POST /signatures/:id/default — make this the caller's default signature.
emailBranding.post('/signatures/:id/default', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const id = c.req.param('id');

  const row = await sql.begin(async (tx) => {
    await tx`
      update email_signatures set is_default = false, updated_at = now()
      where workspace_id = ${workspaceId} and user_id = ${userId} and is_default = true and deleted_at is null
    `;
    const [updated] = await tx`
      update email_signatures set is_default = true, updated_at = now()
      where id = ${id} and workspace_id = ${workspaceId} and user_id = ${userId} and deleted_at is null
      returning ${tx.unsafe(SIG_COLS)}
    `;
    return updated;
  });
  if (!row) return c.json({ error: 'Signature not found' }, 404);
  return c.json({ signature: row });
});

// DELETE /signatures/:id — soft-delete one of the caller's own signatures.
emailBranding.delete('/signatures/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const [row] = await sql`
    update email_signatures set deleted_at = now(), is_default = false, updated_at = now()
    where id = ${id} and workspace_id = ${workspaceId} and user_id = ${userId} and deleted_at is null
    returning id
  `;
  if (!row) return c.json({ error: 'Signature not found' }, 404);
  return c.json({ ok: true });
});
