// Slack inbound event handling. Called after signature verification.
//
// Scope of this first pass: thread-reply → ticket message. We:
//   1. Filter to message events with a thread_ts (root-channel posts
//      and our own bot's posts are skipped).
//   2. Look up the (channel, thread_ts) pair in slack_thread_mappings
//      to find the ticket. Posts in untracked threads are silently
//      ignored.
//   3. Look up the Slack user via users.info to get their email, then
//      match against our users table. A match means the reply lands
//      as role=agent (visible to the customer once outbound delivery
//      ships). No match → role=note (internal-only, attributed as
//      "via Slack: $name").

import { getDb } from './db.ts';

// Migration to Neon — Step 3 (tickets megabatch). DB via getDb().
// Slack users.info HTTP unchanged.

interface SlackEventPayload {
  type:  string;
  event: SlackEventInner;
}

interface SlackEventInner {
  type:        string;       // 'message', 'app_mention', ...
  subtype?:    string;       // 'bot_message', 'message_changed', ...
  bot_id?:     string;       // present on bot posts — we skip these
  user?:       string;       // Slack user id (Uxxxx)
  channel?:    string;
  thread_ts?:  string;
  ts?:         string;
  text?:       string;
}

export async function handleSlackEvent(args: {
  workspaceId: string;
  botToken:    string | null;
  payload:     SlackEventPayload;
}) {
  const { workspaceId, botToken, payload } = args;
  const sql = getDb();
  const ev = payload.event;
  if (!ev || ev.type !== 'message') return;
  if (ev.subtype) return;          // skip edits / joins / channel-name changes / bot_message
  if (ev.bot_id) return;           // skip our own posts
  if (!ev.thread_ts) return;       // root-channel post — not a thread reply
  if (!ev.channel || !ev.user)  return;
  if (!ev.text || !ev.text.trim()) return;

  // Look up the ticket this thread is tied to. Bail silently if the
  // user is replying in some thread we don't know about — keeps random
  // unrelated Slack chatter out of our DB.
  const [mapping] = await sql<{ ticket_id: string }[]>`
    select ticket_id from slack_thread_mappings
    where workspace_id = ${workspaceId} and channel_id = ${ev.channel} and thread_ts = ${ev.thread_ts}
  `;
  if (!mapping) return;

  // Resolve the Slack user → maestro user via email. Requires the
  // bot token + users:read.email scope on the Slack app. Without
  // both we can't attribute the reply, so it falls through to the
  // internal-note path.
  let authorUserId: string | null = null;
  let authorName:   string        = `via Slack: ${ev.user}`;
  if (botToken) {
    const profile = await slackUserInfo(botToken, ev.user);
    if (profile?.email) {
      authorName = `via Slack: ${profile.name || profile.email}`;
      const [u] = await sql<{ id: string; name: string | null }[]>`
        select id, name from users where email = ${profile.email}
      `;
      if (u) {
        authorUserId = u.id;
        authorName   = u.name || profile.email;
      }
    } else if (profile?.name) {
      authorName = `via Slack: ${profile.name}`;
    }
  }

  // Match a maestro user → agent reply (customer-visible); otherwise
  // internal note. The role choice matters: 'agent' rows are sent
  // to the customer via the outbound delivery path (when ready),
  // 'note' rows never leave the workspace.
  const role: 'agent' | 'note' = authorUserId ? 'agent' : 'note';

  try {
    await sql`
      insert into ticket_messages (workspace_id, ticket_id, role, author_user_id, author_label, body)
      values (${workspaceId}, ${mapping.ticket_id}, ${role}, ${authorUserId}, ${authorName}, ${ev.text})
    `;
  } catch (err) {
    console.error('[slack-inbound] ticket_messages insert failed:', err instanceof Error ? err.message : err);
  }
}

interface SlackUserProfile {
  email: string | null;
  name:  string | null;
}

async function slackUserInfo(botToken: string, slackUserId: string): Promise<SlackUserProfile | null> {
  try {
    const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const json = await res.json() as any;
    if (!json.ok) {
      console.warn(`[slack-inbound] users.info failed: ${json.error}`);
      return null;
    }
    return {
      email: json.user?.profile?.email || null,
      name:  json.user?.real_name || json.user?.name || null,
    };
  } catch (err) {
    console.warn('[slack-inbound] users.info error:', err);
    return null;
  }
}
