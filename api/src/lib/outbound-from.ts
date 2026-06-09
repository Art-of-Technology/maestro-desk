import { getDb } from './db.ts';

// Migration to Neon — Step 3 (tickets megabatch). DB via getDb().
// Resolves the per-workspace "From" identity for outbound
// mail: the brand's longest-standing verified email domain → `support@<domain>`.
// Returns null when there's no verified domain (caller falls back to the
// platform-default sender).

export interface OutboundFrom {
  fromEmail: string;
  fromName: string;
}

export async function getOutboundFrom(workspaceId: string): Promise<OutboundFrom | null> {
  const sql = getDb();
  const [ws] = await sql<{ name: string; support_email_display_name: string | null }[]>`
    select name, support_email_display_name from workspaces where id = ${workspaceId}
  `;
  if (!ws) return null;

  const [domain] = await sql<{ domain: string }[]>`
    select domain from workspace_email_domains
    where workspace_id = ${workspaceId} and verified_at is not null and deleted_at is null
    order by created_at asc
    limit 1
  `;
  if (!domain) return null;

  return {
    fromEmail: `support@${domain.domain}`,
    fromName: ws.support_email_display_name?.trim() || ws.name,
  };
}
