import { getDb } from './db.js';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';

export async function getSendingInboxes(workspaceId: string) {
  const rows = await getDb()<{ id: string; address: string; name: string }[]>`
    select ch.id, lower(trim(ch.address)) as address, ch.name from channels ch
    where ch.workspace_id=${workspaceId} and ch.type='email' and ch.status='active' and ch.deleted_at is null
      and exists (select 1 from workspace_email_domains d where d.workspace_id=ch.workspace_id
        and lower(d.domain::text)=split_part(lower(trim(ch.address)), '@', 2)
        and d.verified_at is not null and d.degraded_at is null and d.deleted_at is null)
    order by ch.created_at, ch.id`;
  return rows.filter(row => z.string().email().safeParse(row.address).success && !row.address.endsWith('@inbound.postmarkapp.com'));
}

export async function requireSendingInbox(workspaceId: string, channelId: string) {
  const inbox = (await getSendingInboxes(workspaceId)).find(row => row.id === channelId);
  if (!inbox) throw new HTTPException(409, { message: 'The selected sending inbox is unavailable or no longer verified. Choose another From inbox.' });
  return inbox;
}

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

  // degraded_at filter: a domain whose Postmark verification lapsed (or whose
  // From was rejected at send time) falls back to the platform sender until
  // it re-verifies — see lib/email-domains.ts.
  const [domain] = await sql<{ domain: string }[]>`
    select domain from workspace_email_domains
    where workspace_id = ${workspaceId} and verified_at is not null
      and degraded_at is null and deleted_at is null
    order by created_at asc
    limit 1
  `;
  if (!domain) return null;

  return {
    fromEmail: `support@${domain.domain}`,
    fromName: ws.support_email_display_name?.trim() || ws.name,
  };
}
