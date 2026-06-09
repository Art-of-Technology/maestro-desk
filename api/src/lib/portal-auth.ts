import { randomBytes } from 'node:crypto';
import { getDb } from './db.ts';

// Migration to Neon — Step 3 (portal batch). DB via getDb().

// Token TTLs. Magic link is short so a stolen email can't be used much
// later; session is week-long so customers don't have to re-auth every
// time they want to check on a ticket.
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;       // 15 min
const SESSION_TTL_MS    = 7  * 24 * 60 * 60 * 1000;  // 7 days

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export async function createMagicLink(args: {
  workspaceId: string;
  customerId:  string;
}): Promise<{ token: string; expiresAt: string }> {
  const { workspaceId, customerId } = args;
  const sql = getDb();
  const token = generateToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();
  await sql`
    insert into portal_magic_links (token, workspace_id, customer_id, expires_at)
    values (${token}, ${workspaceId}, ${customerId}, ${expiresAt})
  `;
  return { token, expiresAt };
}

// Atomic exchange: confirm the magic link is unused + unexpired, mark it
// used, mint a session. Returns the session token + customer info.
export async function verifyMagicLink(args: {
  workspaceId: string;
  token:       string;
}): Promise<{ sessionToken: string; customerId: string } | null> {
  const { workspaceId, token } = args;
  const sql = getDb();

  const [link] = await sql<{ customer_id: string; expires_at: string; used_at: string | null }[]>`
    select customer_id, expires_at, used_at
    from portal_magic_links
    where token = ${token} and workspace_id = ${workspaceId}
  `;
  if (!link) return null;
  if (link.used_at) return null;
  if (new Date(link.expires_at).getTime() < Date.now()) return null;

  // Mark used. Defense against double-consume races: include the
  // is-null check in the update predicate so the second writer no-ops.
  const [marked] = await sql`
    update portal_magic_links set used_at = now()
    where token = ${token} and used_at is null
    returning token
  `;
  if (!marked) return null;  // someone else consumed it first

  const sessionToken = generateToken();
  const sessionExpires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await sql`
    insert into portal_sessions (token, workspace_id, customer_id, expires_at)
    values (${sessionToken}, ${workspaceId}, ${link.customer_id}, ${sessionExpires})
  `;

  return { sessionToken, customerId: link.customer_id };
}

export async function customerForSession(args: {
  workspaceId: string;
  sessionToken: string;
}): Promise<{ customerId: string } | null> {
  const { workspaceId, sessionToken } = args;
  const sql = getDb();
  const [row] = await sql<{ customer_id: string; expires_at: string }[]>`
    select customer_id, expires_at
    from portal_sessions
    where token = ${sessionToken} and workspace_id = ${workspaceId}
  `;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { customerId: row.customer_id };
}
