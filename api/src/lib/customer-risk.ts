import { getDb } from './db.js';
import { workerFetch, workerMaestroConfigured, memberNotFound, str } from './maestro.js';

const SPACE_CASINO = '58d5016a-91bb-49e6-a9be-b3f36f08afde';
export type AmlLevel = 'low' | 'medium' | 'high';

// Verified in Space Casino's backoffice: 0=Low, 1=Medium, 2=High.
// Other brands and unrecognised values require a confirmed contract.
export function amlLevel(brandId: string, value: unknown): AmlLevel | null {
  if (brandId !== SPACE_CASINO) return null;
  if (value === 0 || value === '0') return 'low';
  if (value === 1 || value === '1') return 'medium';
  if (value === 2 || value === '2') return 'high';
  return null;
}

export async function customerRisk(workspaceId: string, customerId: string) {
  const sql = getDb();
  const identity = async () => (await sql<{ member_id: string | null; brand_id: string | null }[]>`
    select c.maestro_user_id as member_id, w.maestro_brand_id as brand_id
    from customers c join workspaces w on w.id = c.workspace_id
    where c.id = ${customerId} and c.workspace_id = ${workspaceId}
      and c.deleted_at is null and c.erased_at is null
      and c.merged_into_customer_id is null and w.deleted_at is null
  `)[0];
  const customer = await identity();
  if (!customer) return null;
  // Counts span the full history, including old open complaints. Merged-away
  // and deleted tickets do not count twice. Status semantics belong to the
  // workspace; an unknown status is conservatively treated as non-terminal.
  const [complaints] = await sql<{ open: number; created_last_30_days: number }[]>`
    select count(*) filter (where not coalesce(s.is_terminal, false))::int as open,
      count(*) filter (where t.created_at >= now() - interval '30 days'
        and t.created_at <= now())::int as created_last_30_days
    from tickets t left join ticket_statuses s
      on s.workspace_id = ${workspaceId} and s.key = t.status_key
    where t.workspace_id = ${workspaceId} and t.customer_id = ${customerId}
      and lower(t.category_key) = 'complaints'
      and t.deleted_at is null and t.merged_into_id is null
  `;
  let aml: { state: 'available' | 'unavailable'; level: AmlLevel | null } = { state: 'unavailable', level: null };
  if (customer.brand_id === SPACE_CASINO && customer.member_id && workerMaestroConfigured()) {
    try {
      const member = await workerFetch<Record<string, unknown>>('/api/v1/proxy/member/lookup', {
        brandId: customer.brand_id, query: { memberId: customer.member_id },
      });
      if (!memberNotFound(member) && str(member.userId) === customer.member_id) {
        const level = amlLevel(customer.brand_id, (member.attributes as Record<string, unknown> | null)?.amlRiskLevel);
        if (level) aml = { state: 'available', level };
      }
    } catch { /* An unavailable provider must never be shown as low risk. */ }
  }
  // A lookup can finish after erasure, merge or relinking. Do not publish the
  // previous subject's live risk after the local identity has changed.
  const current = await identity();
  if (!current) return null;
  if (current.member_id !== customer.member_id || current.brand_id !== customer.brand_id) {
    aml = { state: 'unavailable', level: null };
  }
  return { complaints, aml, rg: { state: 'unavailable' }, cdd: { state: 'unavailable' },
    closed_account: { state: 'unavailable' }, checked_at: new Date().toISOString() };
}
