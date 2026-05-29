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

import type { SupabaseClient } from '@supabase/supabase-js';

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
  sb:          SupabaseClient;
  workspaceId: string;
  botToken:    string | null;
  payload:     SlackEventPayload;
}) {
  const { sb, workspaceId, botToken, payload } = args;
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
  const { data: mapping } = await sb
    .from('slack_thread_mappings')
    .select('ticket_id')
    .eq('workspace_id', workspaceId)
    .eq('channel_id', ev.channel)
    .eq('thread_ts', ev.thread_ts)
    .maybeSingle();
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
      const { data: u } = await sb
        .from('users')
        .select('id, name')
        .eq('email', profile.email)
        .maybeSingle();
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

  const { error } = await sb.from('ticket_messages').insert({
    workspace_id:   workspaceId,
    ticket_id:      mapping.ticket_id,
    role,
    author_user_id: authorUserId,
    author_label:   authorName,
    body:           ev.text,
    mentions:       [],
  });
  if (error) {
    console.error('[slack-inbound] ticket_messages insert failed:', error.message);
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
