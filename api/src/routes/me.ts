import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';

// Migration to Neon — Step 3. The caller's own profile + active-workspace
// membership. Scoped to userId/workspaceId from the auth middleware (the
// per-user gate the RLS self-policies provided).
export const me = new Hono();

me.use('*', requireAuth);

const widgetIds = {
  dash: ['today', 'recent', 'status', 'priority', 'sla', 'volume', 'csat', 'agent-load', 'personal', 'ai-tags', 'kb', 'top-customers'],
  report: ['r-status', 'r-sla', 'r-sentiment', 'r-sentiment-trend', 'r-priority', 'r-category', 'r-agents', 'r-csat', 'r-time', 'r-language-detection'],
};
const WidgetScope = z.enum(['dash', 'report']);
const WidgetIds = z.array(z.string().max(64)).max(50).refine(ids => new Set(ids).size === ids.length);
export const WidgetLayoutPatch = z.object({
  scope: WidgetScope,
  layout: z.object({ order: WidgetIds, hidden: WidgetIds }).strict(),
}).strict().refine(({ scope, layout }) => [...layout.order, ...layout.hidden].every(id => widgetIds[scope].includes(id)));

me.get('/widget-layouts/:scope', async c => {
  c.header('Cache-Control', 'no-store');
  const scope = WidgetScope.safeParse(c.req.param('scope'));
  if (!scope.success) return c.json({ error: 'Choose Dashboard or Insights.' }, 400);
  const sql = getDb(), column = scope.data === 'dash' ? 'dashboard_layout' : 'report_layout';
  const [row] = await sql`select ${sql(column)} as layout from user_preferences
    where workspace_id = ${c.get('workspaceId')} and user_id = ${c.get('userId')}`;
  return c.json({ layout: row?.layout ?? null });
});

me.patch('/widget-layouts', async c => {
  c.header('Cache-Control', 'no-store');
  const parsed = WidgetLayoutPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Choose valid widgets for this page.' }, 400);
  const { scope, layout } = parsed.data;
  const sql = getDb(), column = scope === 'dash' ? 'dashboard_layout' : 'report_layout';
  // A page layout is one snapshot. Updating one column preserves the other
  // page's layout and all other preferences, including concurrent saves.
  const [row] = await sql`insert into user_preferences(workspace_id, user_id, ${sql(column)})
    values (${c.get('workspaceId')}, ${c.get('userId')}, ${sql.json(layout)})
    on conflict (workspace_id, user_id) do update set ${sql(column)} = ${sql.json(layout)}
    returning ${sql(column)} as layout`;
  return c.json({ layout: row.layout });
});

// Keep the finite statistic IDs in sync with Dashboard and Insights selectors.
const statFormats: Record<string, readonly string[]> = {};
for (const id of ['dash-status', 'dash-priority', 'dash-sla', 'r-status', 'r-priority', 'r-category', 'r-sentiment', 'r-sla', 'sla-attainment'])
  statFormats[id] = ['table', 'bar', 'donut'];
for (const id of ['dash-volume', 'r-sentiment-trend', 'sla-days', 'ai-trend', 'detection-trend'])
  statFormats[id] = ['table', 'bar', 'line'];
for (const id of ['dash-agent-load', 'dash-top-customers', 'r-agents', 'r-csat', 'r-time', 'sla-target', 'ai-agents', 'ai-languages', 'ai-types', 'ai-problems', 'detection-reasons'])
  statFormats[id] = ['table', 'bar'];

export const StatViewPatch = z.object({
  id: z.string().max(64),
  format: z.enum(['table', 'bar', 'donut', 'line']),
  only_if_missing: z.boolean().default(false),
}).strict().refine(v => Object.hasOwn(statFormats, v.id) && statFormats[v.id].includes(v.format));

me.get('/stat-views', async c => {
  c.header('Cache-Control', 'no-store');
  const sql = getDb();
  const [row] = await sql`select stat_views from user_preferences
    where workspace_id = ${c.get('workspaceId')} and user_id = ${c.get('userId')}`;
  return c.json({ views: row?.stat_views ?? {} });
});

me.patch('/stat-views', async c => {
  c.header('Cache-Control', 'no-store');
  const parsed = StatViewPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Choose a supported statistic and view format.' }, 400);
  const { id, format, only_if_missing } = parsed.data;
  const sql = getDb();
  // One atomic key update preserves other devices' choices. Importing an old
  // browser choice must never replace an existing server choice, even in a race.
  const [row] = await sql`insert into user_preferences(workspace_id, user_id, stat_views)
    values (${c.get('workspaceId')}, ${c.get('userId')}, ${sql.json({ [id]: format })})
    on conflict (workspace_id, user_id) do update set stat_views =
      case when ${only_if_missing} and user_preferences.stat_views ? ${id}
        then user_preferences.stat_views
        else user_preferences.stat_views || excluded.stat_views end
    returning stat_views ->> ${id} as format`;
  return c.json({ format: row.format });
});

me.get('/', async (c) => {
  const sql = getDb();
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');

  const [user] = await sql`
    select id, email, name, initials, is_platform_admin, mention_email_enabled
    from users where id = ${userId}
  `;
  if (!user) return c.json({ error: 'User not found' }, 404);

  const [membership] = await sql`
    select wm.role_id, wm.active, wm.ooo_from, wm.ooo_to, wm.ooo_note,
           json_build_object('name', r.name, 'is_admin', r.is_admin) as roles
    from workspace_members wm
    left join roles r on r.id = wm.role_id
    where wm.user_id = ${userId} and wm.workspace_id = ${workspaceId}
  `;
  const [workspace] = await sql`
    select id, name, slug, logo_url, primary_color from workspaces where id = ${workspaceId}
  `;

  return c.json({ user, workspace_id: workspaceId, workspace: workspace ?? null, membership: membership ?? null });
});

// Self-PATCH for the small set of fields a user can edit on their own row.
// Scoped to id = userId — a user can only ever update their own row.
const MePatch = z.object({
  mention_email_enabled: z.boolean().optional(),
}).strict();

me.patch('/', async (c) => {
  const sql = getDb();
  const userId = c.get('userId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = MePatch.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  const [user] = await sql`
    update users set ${sql(parsed.data)}
    where id = ${userId}
    returning id, email, name, initials, is_platform_admin, mention_email_enabled
  `;
  if (!user) return c.json({ error: 'User not found' }, 404);
  return c.json({ user });
});
