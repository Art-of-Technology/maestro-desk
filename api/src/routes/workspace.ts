import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';
import { requireWorkspaceAdmin } from '../lib/authz.ts';
import { putObject, listKeys, deleteKeys, publicUrl } from '../lib/r2.ts';

// Migration to Neon — Step 3 (DB access on getDb(), admin gate via
// requireWorkspaceAdmin) + Step 4 (POST /branding/logo now stores the file in
// Cloudflare R2 instead of Supabase Storage). This route no longer touches
// Supabase at all.
export const workspace = new Hono();

workspace.use('*', requireAuth);

const SETTINGS_COLS = `id, name, slug, logo_url, primary_color, auto_priority_bump_on_angry,
  csat_reminder_days, portal_tagline, portal_intro, portal_footer,
  portal_custom_domain, portal_custom_domain_token, portal_custom_domain_verified`;

// ─── GET /settings ──────────────────────────────────────────────────────
workspace.get('/settings', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const [row] = await sql`select ${sql.unsafe(SETTINGS_COLS)} from workspaces where id = ${workspaceId}`;
  if (!row) return c.json({ error: 'Workspace not found' }, 404);
  return c.json({ workspace: row });
});

const SettingsBody = z.object({
  auto_priority_bump_on_angry: z.boolean().optional(),
  csat_reminder_days: z.array(z.number().int().min(1).max(365))
    .max(6)
    .refine((arr) => arr.every((v, i) => i === 0 || v > arr[i - 1]), 'csat_reminder_days must be strictly ascending')
    .optional(),
  logo_url:      z.string().url().nullable().optional(),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/, 'primary_color must be a hex like #8b5cf6').nullable().optional(),
  portal_tagline: z.string().max(100).nullable().optional(),
  portal_intro:   z.string().max(1000).nullable().optional(),
  portal_footer:  z.string().max(500).nullable().optional(),
  portal_custom_domain: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, 'Invalid hostname').max(253).nullable().optional(),
}).strict();

// ─── POST /branding/logo — admin; Cloudflare R2 upload (Step 4) ───────────
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);
const MAX_BYTES    = 2 * 1024 * 1024;

workspace.post('/branding/logo', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const form = await c.req.parseBody({ all: false }).catch(() => null);
  const file = form?.file as File | undefined;
  if (!file || typeof file === 'string') return c.json({ error: 'Missing file part' }, 400);
  if (file.size === 0) return c.json({ error: 'Empty file' }, 400);
  if (file.size > MAX_BYTES) return c.json({ error: `File too large; max ${MAX_BYTES} bytes` }, 400);
  if (!ALLOWED_MIME.has(file.type)) return c.json({ error: `Unsupported MIME type: ${file.type}` }, 400);

  const extByMime: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp',
  };
  const key = `${workspaceId}/logo-${Date.now()}.${extByMime[file.type]}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    await putObject(key, bytes, file.type);
  } catch (err) {
    // Log the detail server-side (it can include the R2/S3 error body, which
    // may echo signing internals); return a generic message to the client.
    console.error('[workspace-branding] R2 upload failed:', err instanceof Error ? err.message : err);
    return c.json({ error: 'Upload failed' }, 500);
  }

  // Best-effort cleanup of older files under this workspace's prefix.
  try {
    const stale = (await listKeys(`${workspaceId}/`)).filter((k) => k !== key);
    await deleteKeys(stale);
  } catch (err) {
    console.warn('[workspace-branding] cleanup failed:', err instanceof Error ? err.message : err);
  }

  const logoUrl = publicUrl(key);
  await sql`update workspaces set logo_url = ${logoUrl} where id = ${workspaceId}`;
  return c.json({ logo_url: logoUrl }, 201);
});

// ─── PATCH /settings — admin ────────────────────────────────────────────
workspace.patch('/settings', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = SettingsBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  // Changing portal_custom_domain rotates the verification state.
  const updates: Record<string, unknown> = { ...parsed.data };
  if ('portal_custom_domain' in parsed.data) {
    const incoming = parsed.data.portal_custom_domain ? parsed.data.portal_custom_domain.trim().toLowerCase() : null;
    updates.portal_custom_domain = incoming;
    updates.portal_custom_domain_token    = incoming === null ? null : generateDomainToken();
    updates.portal_custom_domain_verified = false;
  }

  try {
    const [row] = await sql`
      update workspaces set ${sql(updates)}
      where id = ${workspaceId}
      returning ${sql.unsafe(SETTINGS_COLS)}
    `;
    if (!row) return c.json({ error: 'Workspace not found' }, 404);
    return c.json({ workspace: row });
  } catch (err) {
    if ((err as any)?.code === '23505') {
      return c.json({ error: 'That hostname is already claimed by another workspace' }, 409);
    }
    throw err;
  }
});

// ─── POST /domain/verify — admin; resolve TXT record + flip verified ──────
workspace.post('/domain/verify', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const [ws] = await sql`
    select portal_custom_domain, portal_custom_domain_token from workspaces where id = ${workspaceId}
  `;
  if (!ws?.portal_custom_domain || !ws?.portal_custom_domain_token) {
    return c.json({ error: 'No custom domain configured' }, 400);
  }

  const recordName = `_maestro-verify.${ws.portal_custom_domain}`;
  let txtValues: string[][];
  try {
    const dns = await import('node:dns/promises');
    txtValues = await dns.resolveTxt(recordName);
  } catch (err: any) {
    const code = err?.code || 'UNKNOWN';
    return c.json({
      verified: false,
      reason: code === 'ENOTFOUND' || code === 'ENODATA' ? 'no_txt_record' : `dns_error:${code}`,
      record_name: recordName,
      expected_value: ws.portal_custom_domain_token,
    });
  }
  const flat = txtValues.flat();
  if (!flat.includes(ws.portal_custom_domain_token)) {
    return c.json({
      verified: false, reason: 'mismatch', record_name: recordName,
      expected_value: ws.portal_custom_domain_token, found_values: flat,
    });
  }

  await sql`update workspaces set portal_custom_domain_verified = true where id = ${workspaceId}`;
  return c.json({ verified: true });
});

function generateDomainToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return 'maestro-verify-' + Buffer.from(bytes).toString('base64url');
}
