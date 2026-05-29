import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const workspace = new Hono();

workspace.use('*', requireAuth);

// ─── GET /api/v1/workspace/settings ─────────────────────────────────────
//
// Returns the workspace-level flags an agent can read (and admins can
// edit through the PATCH below). Kept narrow — sensitive columns like
// ai_credits_micro stay on the god endpoints.
workspace.get('/settings', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const { data, error } = await sb
    .from('workspaces')
    .select('id, name, slug, logo_url, primary_color, auto_priority_bump_on_angry, csat_reminder_days, portal_tagline, portal_intro, portal_footer')
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Workspace not found' }, 404);
  return c.json({ workspace: data });
});

// ─── PATCH /api/v1/workspace/settings ───────────────────────────────────
//
// Admin-only writes. We use the service-role client for the actual
// UPDATE because the workspaces table only has a SELECT policy under
// the JWT-claim regime today — a workspace-admin-write policy + a
// matching sbUser flip would be a separate slice. The admin check
// runs via the existing is_workspace_admin helper, called as an RPC
// against the sbUser client so the JWT context drives the decision.
// csat_reminder_days validation: 0–6 entries, each 1–365 days,
// strictly ascending. The DB CHECK enforces length only; ordering +
// per-element bounds live here so a clean 400 surfaces in the SPA
// instead of an opaque postgres error. Empty array is valid and
// means "no reminders" for that workspace.
const SettingsBody = z.object({
  auto_priority_bump_on_angry: z.boolean().optional(),
  csat_reminder_days: z.array(z.number().int().min(1).max(365))
    .max(6)
    .refine(
      (arr) => arr.every((v, i) => i === 0 || v > arr[i - 1]),
      'csat_reminder_days must be strictly ascending',
    )
    .optional(),
  // Workspace branding. logo_url accepts plain http(s) — anything more
  // restrictive (signed URLs, allowlisted CDNs) would belong in a
  // file-upload-and-host slice rather than here. Null clears.
  logo_url:      z.string().url().nullable().optional(),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/, 'primary_color must be a hex like #8b5cf6').nullable().optional(),
  // Customer-portal copy. All optional + bounded to match the DB
  // CHECK lengths (100 / 1000 / 500). Empty strings normalise to
  // null in the SPA so "" doesn't sneak past the nullable.
  portal_tagline: z.string().max(100).nullable().optional(),
  portal_intro:   z.string().max(1000).nullable().optional(),
  portal_footer:  z.string().max(500).nullable().optional(),
}).strict();

// ─── POST /api/v1/workspace/branding/logo ───────────────────────────────
//
// First-party logo upload. Workspace admin sends a multipart form
// with a `file` part; we validate (size + MIME), upload to the
// brand-assets storage bucket under {workspace_id}/logo-{ts}.{ext},
// then update workspaces.logo_url to the new public URL. Returns
// the public URL so the SPA can swap the preview in-place.
//
// Files are written via service-role (storage.objects has no INSERT
// policy for authenticated users by design) but the admin check
// runs via sbUser/is_workspace_admin — same shape as the settings
// PATCH.
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);
const MAX_BYTES    = 2 * 1024 * 1024;  // 2 MB

workspace.post('/branding/logo', async (c) => {
  const sbUser  = c.get('sbUser');
  const sbAdmin = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const { data: isAdmin, error: rpcErr } = await sbUser.rpc('is_workspace_admin', { ws: workspaceId });
  if (rpcErr) return c.json({ error: rpcErr.message }, 500);
  if (!isAdmin) return c.json({ error: 'Admin permission required' }, 403);

  // Hono's parseBody returns the multipart parts as plain values; the
  // `file` part comes through as a Blob/File-like object with a
  // .type and a .size we can validate before uploading.
  const form = await c.req.parseBody({ all: false }).catch(() => null);
  const file = form?.file as File | undefined;
  if (!file || typeof file === 'string') return c.json({ error: 'Missing file part' }, 400);
  if (file.size === 0) return c.json({ error: 'Empty file' }, 400);
  if (file.size > MAX_BYTES) return c.json({ error: `File too large; max ${MAX_BYTES} bytes` }, 400);
  if (!ALLOWED_MIME.has(file.type)) {
    return c.json({ error: `Unsupported MIME type: ${file.type}` }, 400);
  }

  // Map the MIME to a sensible extension. Trust the MIME (already
  // allow-listed) over the client filename which can lie.
  const extByMime: Record<string, string> = {
    'image/png':     'png',
    'image/jpeg':    'jpg',
    'image/svg+xml': 'svg',
    'image/webp':    'webp',
  };
  const ext  = extByMime[file.type];
  const path = `${workspaceId}/logo-${Date.now()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const upload = await sbAdmin.storage.from('brand-assets').upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (upload.error) return c.json({ error: `Upload failed: ${upload.error.message}` }, 500);

  // Clean up older files under this workspace's prefix so a churning
  // admin doesn't leak storage. Best-effort — a failure here doesn't
  // unwind the new upload (the workspace is now live with the new URL,
  // and orphan files in a 2 MB bucket are not worth a rollback).
  try {
    const { data: existing } = await sbAdmin.storage.from('brand-assets').list(workspaceId);
    const stale = (existing || []).filter((e) => `${workspaceId}/${e.name}` !== path).map((e) => `${workspaceId}/${e.name}`);
    if (stale.length > 0) await sbAdmin.storage.from('brand-assets').remove(stale);
  } catch (err) {
    console.warn('[workspace-branding] cleanup failed:', err instanceof Error ? err.message : err);
  }

  const { data: { publicUrl } } = sbAdmin.storage.from('brand-assets').getPublicUrl(path);

  const { error: updErr } = await sbAdmin
    .from('workspaces')
    .update({ logo_url: publicUrl })
    .eq('id', workspaceId);
  if (updErr) return c.json({ error: updErr.message }, 500);

  return c.json({ logo_url: publicUrl }, 201);
});

workspace.patch('/settings', async (c) => {
  const sbUser  = c.get('sbUser');
  const sbAdmin = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = SettingsBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  const { data: isAdmin, error: rpcErr } = await sbUser.rpc('is_workspace_admin', { ws: workspaceId });
  if (rpcErr) return c.json({ error: rpcErr.message }, 500);
  if (!isAdmin) return c.json({ error: 'Admin permission required' }, 403);

  const { data, error } = await sbAdmin
    .from('workspaces')
    .update(parsed.data)
    .eq('id', workspaceId)
    .select('id, name, slug, logo_url, primary_color, auto_priority_bump_on_angry, csat_reminder_days, portal_tagline, portal_intro, portal_footer')
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Workspace not found' }, 404);
  return c.json({ workspace: data });
});
