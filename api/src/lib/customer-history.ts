import type { TransactionSql } from 'postgres';

// Never infer ownership by searching other customers' free text or reused email
// addresses. Historical rows without these links need separate operator review.
export function customerAuditHistory(sql: TransactionSql, workspaceId: string, customerId: string, countOnly = false) {
  return sql`with owned as (
    select id from tickets where workspace_id=${workspaceId}
      and (customer_id=${customerId} or pre_merge_customer_id=${customerId})
  ) select ${countOnly ? sql`count(*)::int as count` : sql`a.id,a.action,a.target_type,a.target_id,a.actor_user_id,a.actor_ip,a.actor_ua,a.metadata,a.created_at`}
    from audit_events a where a.workspace_id=${workspaceId} and (
      (a.target_type='customer' and a.target_id=${customerId})
      or a.metadata->>'customer_id'=${customerId} or a.metadata->>'original_customer_id'=${customerId}
      or (a.target_type='ticket' and a.target_id in (select id from owned))
      or a.metadata->>'ticket_id' in (select id::text from owned)
      or (a.target_type='player' and a.target_id::text in
        (select maestro_user_id::text from customers where id=${customerId} and workspace_id=${workspaceId}))
      or a.id in (select unnest(retained_player_audit_ids) from gdpr_erasures
        where customer_id=${customerId} and workspace_id=${workspaceId})
    ) ${countOnly ? sql`` : sql`order by a.seq`}`;
}
