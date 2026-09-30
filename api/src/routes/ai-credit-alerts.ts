import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';

// Mounted under the authenticated, workspace-scoped AI router.
export const aiCreditAlerts = new Hono();
aiCreditAlerts.use('*', async (c, next) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  await next();
});
aiCreditAlerts.get('/', async c => {
  const sql = getDb();
  const [row] = await sql`
    select to_char(w.ai_low_credit_since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as since,
      w.ai_credits_micro + w.ai_reserved_micro as balance,
      coalesce(r.low_since = w.ai_low_credit_since, false) as read,
      coalesce(r.low_since = w.ai_low_credit_since and r.dismissed, false) as dismissed
    from workspaces w left join ai_credit_alert_receipts r
      on r.workspace_id=w.id and r.user_id=${c.get('userId')}
    where w.id=${c.get('workspaceId')} and w.deleted_at is null and w.ai_low_credit_since is not null
  `;
  return c.json({ alert: row ? { since: row.since, balance_micro: Number(row.balance), read: row.read, dismissed: row.dismissed } : null });
});
aiCreditAlerts.post('/', async c => {
  const parsed = z.object({ since: z.string().datetime(), dismissed: z.boolean().default(false) }).strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid notification.' }, 400);
  const sql = getDb();
  await sql`
    insert into ai_credit_alert_receipts(workspace_id,user_id,low_since,dismissed)
    select id,${c.get('userId')},ai_low_credit_since,${parsed.data.dismissed}
    from workspaces where id=${c.get('workspaceId')} and ai_low_credit_since=${parsed.data.since}::text::timestamptz
    on conflict(workspace_id,user_id) do update set low_since=excluded.low_since,
      dismissed=excluded.dismissed or (ai_credit_alert_receipts.low_since=excluded.low_since and ai_credit_alert_receipts.dismissed)
    where ai_credit_alert_receipts.low_since <= excluded.low_since
  `;
  return c.json({ ok: true });
});
