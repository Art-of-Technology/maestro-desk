import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

// Admin-managed ticket categories.
//
//   GET    /api/v1/categories        — list (any workspace member; the SPA
//                                       New-Ticket dropdown filters is_active)
//   POST   /api/v1/categories        — create (admin); body { label }
//   PATCH  /api/v1/categories/:key   — rename / enable-disable (admin)
//
// There is no DELETE: retiring a category is is_active=false (reversible,
// keeps existing tickets' category_key valid). Reads go through sbUser so the
// select RLS policy applies; the admin check runs via the is_workspace_admin
// RPC (same shape as routes/workspace.ts) and the write RLS policy enforces it
// again as defense-in-depth.
export const categories = new Hono();

categories.use('*', requireAuth);

// Generate a stable, space-free key from a human label.
//   "Due Diligence" -> "DueDiligence", "VIP players!" -> "VIPplayers"
// Keys are the value stored on tickets.category_key, so they must not change
// once assigned — PATCH only ever touches the label, never the key.
function keyFromLabel(label: string): string {
  return label
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

async function requireAdmin(c: Context): Promise<Response | null> {
  const sbUser = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const { data: isAdmin, error } = await sbUser.rpc('is_workspace_admin', { ws: workspaceId });
  if (error) return c.json({ error: error.message }, 500);
  if (!isAdmin) return c.json({ error: 'Admin permission required' }, 403);
  return null;
}

// ─── GET / — list all categories (active + inactive) ─────────────────────
categories.get('/', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');

  const { data, error } = await sb
    .from('ticket_categories')
    .select('key, label, is_active')
    .eq('workspace_id', workspaceId)
    .order('label', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);

  return c.json({ categories: data ?? [] });
});

// ─── POST / — create a category (admin) ──────────────────────────────────
const PostCategory = z.object({
  label: z.string().trim().min(1).max(64),
}).strict();

categories.post('/', async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;

  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');

  const body = await c.req.json().catch(() => null);
  const parsed = PostCategory.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const label = parsed.data.label;
  const key = keyFromLabel(label);
  if (!key) {
    return c.json({ error: 'Label must contain at least one letter or digit' }, 400);
  }

  // Insert first (atomic — no check-then-insert race); on a PK clash, look up
  // the existing row to return a useful message. Near-duplicate labels can map
  // to the same key (e.g. "Payments" / "payments" → "Payments"), and the
  // clashing row may be DISABLED — in which case the admin should re-enable it
  // rather than be told it "already exists" with no way to see it.
  const { data, error } = await sb
    .from('ticket_categories')
    .insert({ workspace_id: workspaceId, key, label, is_active: true })
    .select('key, label, is_active')
    .single();
  // 23505 = unique_violation on the (workspace_id, key) primary key.
  if (error) {
    if ((error as any).code === '23505') {
      const { data: clash, error: clashErr } = await sb
        .from('ticket_categories')
        .select('key, label, is_active')
        .eq('workspace_id', workspaceId)
        .eq('key', key)
        .maybeSingle();
      // Best-effort enrichment only — the 23505 already tells us it's a
      // conflict, so a failed/raced lookup just degrades to a generic message.
      if (clashErr) console.warn('[categories] conflict lookup failed:', clashErr.message);
      const hint = clash && !clash.is_active
        ? ' It is currently disabled — re-enable it instead of creating a duplicate.'
        : '';
      return c.json(
        { error: `Category "${clash?.label ?? label}" already exists (key "${key}").${hint}`, existing: clash ?? null },
        409,
      );
    }
    return c.json({ error: error.message }, 500);
  }

  return c.json({ category: data }, 201);
});

// ─── PATCH /:key — rename or enable/disable (admin) ──────────────────────
const PatchCategory = z.object({
  label:     z.string().trim().min(1).max(64).optional(),
  is_active: z.boolean().optional(),
}).strict();

categories.patch('/:key', async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;

  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const key = c.req.param('key');

  const body = await c.req.json().catch(() => null);
  const parsed = PatchCategory.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  const { data, error } = await sb
    .from('ticket_categories')
    .update(parsed.data)
    .eq('workspace_id', workspaceId)
    .eq('key', key)
    .select('key, label, is_active')
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Category not found' }, 404);

  return c.json({ category: data });
});
