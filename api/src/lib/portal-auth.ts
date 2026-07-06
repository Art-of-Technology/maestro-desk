import { randomBytes, createHash } from 'node:crypto';
import { getDb } from './db.js';

// Migration to Neon — Step 3 (portal batch). DB via getDb().

// Token TTLs. Magic link is short so a stolen email can't be used much
// later; session is week-long so customers don't have to re-auth every
// time they want to check on a ticket.
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;       // 15 min
const SESSION_TTL_MS    = 7  * 24 * 60 * 60 * 1000;  // 7 days

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

// We store only the SHA-256 of each token, never the raw value (advisory #21):
// the raw token lives only in the customer's URL/cookie, so a DB read (backup,
// leak, SQLi elsewhere) can't yield a usable token. Lookups hash the incoming
// token and match on the digest. SHA-256 (not a slow KDF) is right here — these
// are 256-bit random tokens, not low-entropy passwords, so there's nothing to
// brute-force.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
    values (${hashToken(token)}, ${workspaceId}, ${customerId}, ${expiresAt})
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
  const tokenHash = hashToken(token);

  const [link] = await sql<{ customer_id: string; expires_at: string; used_at: string | null }[]>`
    select customer_id, expires_at, used_at
    from portal_magic_links
    where token = ${tokenHash} and workspace_id = ${workspaceId}
  `;
  if (!link) return null;
  if (link.used_at) return null;
  if (new Date(link.expires_at).getTime() < Date.now()) return null;

  // Mark used. Defense against double-consume races: include the
  // is-null check in the update predicate so the second writer no-ops.
  const [marked] = await sql`
    update portal_magic_links set used_at = now()
    where token = ${tokenHash} and used_at is null
    returning token
  `;
  if (!marked) return null;  // someone else consumed it first

  const sessionToken = generateToken();
  const sessionExpires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await sql`
    insert into portal_sessions (token, workspace_id, customer_id, expires_at)
    values (${hashToken(sessionToken)}, ${workspaceId}, ${link.customer_id}, ${sessionExpires})
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
    where token = ${hashToken(sessionToken)} and workspace_id = ${workspaceId}
  `;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { customerId: row.customer_id };
}
