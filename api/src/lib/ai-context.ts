import { getDb } from './db.js';

export type AIContextSource = 'tickets' | 'customers' | 'agents' | 'kb';

// Read context from the authenticated workspace, never browser snapshots.
// Account attributes are opt-in; AML, contact details and live balances are
// deliberately absent. Free-form ticket text can still contain personal data.
export async function buildAIContext(workspaceId: string, sources: AIContextSource[]): Promise<string> {
  const sql = getDb();
  const [workspace] = await sql`select ai_player_enrichment from workspaces where id = ${workspaceId}`;
  const parts: string[] = [];
  if (sources.includes('tickets')) {
    const rows = await sql`
      select display_id, left(subject, 300) as subject, status_key, priority_key,
             category_key, customer_id, assigned_user_id
      from tickets where workspace_id = ${workspaceId} and deleted_at is null
      order by updated_at desc, id limit 100
    `;
    parts.push('TICKETS (up to 100 most recently updated):\n' + JSON.stringify(rows));
  }
  if (sources.includes('customers')) {
    const rows = await sql`
      select id, display_id, left(first_name, 80) as first_name, left(last_name, 80) as last_name,
             case when ${workspace?.ai_player_enrichment === true} then vip_tier end as vip_tier,
             case when ${workspace?.ai_player_enrichment === true} then brand end as brand,
             case when ${workspace?.ai_player_enrichment === true} then jurisdiction end as jurisdiction
      from customers where workspace_id = ${workspaceId} and deleted_at is null
        and erased_at is null and merged_into_customer_id is null
      order by updated_at desc, id limit 100
    `;
    parts.push('CUSTOMERS (up to 100 most recently updated):\n' + JSON.stringify(rows));
  }
  if (sources.includes('agents')) {
    const rows = await sql`
      select u.id, left(u.name, 120) as name, wm.active, r.name as role
      from workspace_members wm join users u on u.id = wm.user_id and u.deleted_at is null
      left join roles r on r.id = wm.role_id and r.workspace_id = wm.workspace_id
      where wm.workspace_id = ${workspaceId} order by wm.joined_at, u.id limit 100
    `;
    parts.push('AGENTS (up to 100):\n' + JSON.stringify(rows));
  }
  if (sources.includes('kb')) {
    const rows = await sql`
      select display_id, left(title, 300) as title, category
      from kb_articles where workspace_id = ${workspaceId} and status = 'published'
      order by updated_at desc, id limit 100
    `;
    parts.push('PUBLISHED KNOWLEDGE BASE TITLES (up to 100):\n' + JSON.stringify(rows));
  }
  return parts.length ? parts.join('\n\n').slice(0, 50000) : 'No workspace context selected.';
}
