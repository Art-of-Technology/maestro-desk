import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';
import { requirePermission } from '../lib/role-permissions.js';

// Admin-managed ticket categories. (Migration to Neon — Step 3, PR 3.1: this
// is the template route. Data access is raw SQL on Neon via getDb(); the
// admin gate is the requireWorkspaceAdmin helper that replaces the Supabase
// `is_workspace_admin` RPC + the admin-write RLS policy.)
//
//   GET    /api/v1/categories        — list (any workspace member; the SPA
//                                       New-Ticket dropdown filters is_active)
//   POST   /api/v1/categories        — create (admin); body { label }
//   PATCH  /api/v1/categories/:key   — rename / enable-disable (admin)
//
// There is no DELETE: retiring a category is is_active=false (reversible,
// keeps existing tickets' category_key valid). Membership is verified by the
// auth middleware; the GET is open to any member, writes require admin.
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

// ─── GET / — list all categories (active + inactive) ─────────────────────
categories.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql`
    select key, label, is_active
    from ticket_categories
    where workspace_id = ${workspaceId}
    order by label asc
  `;
  return c.json({ categories: rows });
});

// ─── POST / — create a category (admin) ──────────────────────────────────
const PostCategory = z.object({
  label: z.string().trim().min(1).max(64),
}).strict();

categories.post('/', async (c) => {
  const denied = await requirePermission(c, 'admin.inboxes');
  if (denied) return denied;

  const sql = getDb();
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
  try {
    const [row] = await sql`
      insert into ticket_categories (workspace_id, key, label, is_active)
      values (${workspaceId}, ${key}, ${label}, true)
      returning key, label, is_active
    `;
    return c.json({ category: row }, 201);
  } catch (err) {
    // 23505 = unique_violation on the (workspace_id, key) primary key.
    if ((err as any)?.code === '23505') {
      const [clash] = await sql`
        select key, label, is_active
        from ticket_categories
        where workspace_id = ${workspaceId} and key = ${key}
      `;
      const hint = clash && !clash.is_active
        ? ' It is currently disabled — re-enable it instead of creating a duplicate.'
        : '';
      return c.json(
        { error: `Category "${clash?.label ?? label}" already exists (key "${key}").${hint}`, existing: clash ?? null },
        409,
      );
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ─── PATCH /:key — rename or enable/disable (admin) ──────────────────────
const PatchCategory = z.object({
  label:     z.string().trim().min(1).max(64).optional(),
  is_active: z.boolean().optional(),
}).strict();

categories.patch('/:key', async (c) => {
  const denied = await requirePermission(c, 'admin.inboxes');
  if (denied) return denied;

  const sql = getDb();
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

  // sql(obj) renders "set label = $1, is_active = $2" for whichever keys are present.
  const [row] = await sql`
    update ticket_categories
    set ${sql(parsed.data)}
    where workspace_id = ${workspaceId} and key = ${key}
    returning key, label, is_active
  `;
  if (!row) return c.json({ error: 'Category not found' }, 404);

  return c.json({ category: row });
});
