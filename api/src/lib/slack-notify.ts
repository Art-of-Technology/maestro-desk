import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Event types ─────────────────────────────────────────────────────────
//
// Keep these strings stable — they're stored as workspace config in
// slack_integrations.events. Renaming = silently disabling existing
// subscriptions.

export type SlackEvent =
  | 'ticket.created'
  | 'ticket.resolved'
  | 'ticket.escalated'
  | 'priority.urgent';

interface TicketCtx {
  display_id:   string;
  subject:      string;
  status_key?:  string;
  priority_key?: string;
  customer_name?: string | null;
  customer_vip?:  string | null;
  customer_brand?: string | null;
  agent_name?:    string | null;
}

// ─── Message formatting ─────────────────────────────────────────────────
//
// Slack Incoming Webhooks accept either `text` (plain) or Block Kit
// `blocks`. We send Block Kit for the header + a fields block for the
// metadata, plus a fallback `text` for older clients / notification
// previews.

function buildBlocks(event: SlackEvent, t: TicketCtx) {
  const verbByEvent: Record<SlackEvent, string> = {
    'ticket.created':   '🎟️  New ticket',
    'ticket.resolved':  '✅ Ticket resolved',
    'ticket.escalated': '🔺 Ticket escalated',
    'priority.urgent':  '🚨 Ticket marked urgent',
  };
  const header = `${verbByEvent[event]} — ${t.display_id}`;
  const fallback = `${header}\n${t.subject}`;

  const fields: Array<{ type: 'mrkdwn'; text: string }> = [];
  if (t.customer_name) {
    const brandTag = t.customer_brand ? ` (${t.customer_brand}${t.customer_vip ? `, ${t.customer_vip}` : ''})` : '';
    fields.push({ type: 'mrkdwn', text: `*Customer*\n${t.customer_name}${brandTag}` });
  }
  if (t.agent_name)    fields.push({ type: 'mrkdwn', text: `*Assignee*\n${t.agent_name}` });
  if (t.priority_key)  fields.push({ type: 'mrkdwn', text: `*Priority*\n${t.priority_key}` });
  if (t.status_key)    fields.push({ type: 'mrkdwn', text: `*Status*\n${t.status_key}` });

  const blocks: any[] = [
    { type: 'header',  text: { type: 'plain_text', text: header } },
    { type: 'section', text: { type: 'mrkdwn',     text: `*${escapeSlack(t.subject)}*` } },
  ];
  if (fields.length > 0) blocks.push({ type: 'section', fields });

  return { text: fallback, blocks };
}

// Slack-flavoured mrkdwn escape: just the three characters that
// otherwise act as formatting markers.
function escapeSlack(s: string): string {
  return String(s ?? '').replace(/[<>&]/g, (ch) => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[ch] || ch));
}

// ─── Entry point ─────────────────────────────────────────────────────────
//
// Called from the ticket-mutation paths. Fire-and-forget intended —
// the caller awaits but the body is wrapped in a try so a Slack outage
// can't break the user's PATCH. Returns true if a post was attempted.

export async function notifySlack(args: {
  sb:          SupabaseClient;
  workspaceId: string;
  event:       SlackEvent;
  ticketId:    string;
}): Promise<boolean> {
  const { sb, workspaceId, event, ticketId } = args;

  const { data: integration } = await sb
    .from('slack_integrations')
    .select('webhook_url, channel, active, events, bot_token')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!integration || !integration.active) return false;
  if (!Array.isArray(integration.events) || !integration.events.includes(event)) return false;

  // Ticket + customer in one round-trip. Tickets has multiple FKs to
  // users (assigned_user_id, snoozed_by_user_id) so the user embed
  // would be ambiguous — fetch the assignee separately when needed.
  const { data: ticket } = await sb
    .from('tickets')
    .select(`
      display_id, subject, status_key, priority_key, assigned_user_id,
      customers(first_name, last_name, vip_tier, brand)
    `)
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!ticket) return false;

  const customer = (ticket as any).customers || {};
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null;

  let assignee: { name?: string } = {};
  const assigneeId = (ticket as any).assigned_user_id;
  if (assigneeId) {
    const { data: u } = await sb.from('users').select('name').eq('id', assigneeId).maybeSingle();
    if (u) assignee = u;
  }

  const ctx: TicketCtx = {
    display_id:     (ticket as any).display_id,
    subject:        (ticket as any).subject,
    status_key:     (ticket as any).status_key,
    priority_key:   (ticket as any).priority_key,
    customer_name:  customerName,
    customer_vip:   customer.vip_tier || null,
    customer_brand: customer.brand || null,
    agent_name:     assignee.name || null,
  };
  const payload = buildBlocks(event, ctx);

  // Two-way mode: bot_token + channel configured. We use chat.postMessage
  // so we get the message timestamp back (= thread_ts for the root) and
  // can stitch later replies to the same thread. On ticket.created we
  // upsert the thread mapping; on subsequent events we reuse it so
  // resolved/escalated/urgent post as thread replies instead of
  // spamming the channel root.
  if (integration.bot_token && integration.channel) {
    try {
      const existing = await getThreadMapping(sb, workspaceId, ticketId);
      const postBody: any = {
        channel: existing?.channel_id || integration.channel,
        text:    payload.text,
        blocks:  payload.blocks,
      };
      if (existing) postBody.thread_ts = existing.thread_ts;

      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json; charset=utf-8',
          'Authorization': `Bearer ${integration.bot_token}`,
        },
        body: JSON.stringify(postBody),
      });
      const json = await res.json().catch(() => ({})) as any;
      if (!json.ok) {
        console.warn(`[slack] chat.postMessage failed: ${json.error || res.status}`);
        return true;
      }
      // First message in this thread — record the mapping so replies
      // come back via /webhooks/slack/events.
      if (!existing && json.ts && json.channel) {
        await sb
          .from('slack_thread_mappings')
          .upsert(
            { workspace_id: workspaceId, ticket_id: ticketId, channel_id: json.channel, thread_ts: json.ts },
            { onConflict: 'workspace_id,ticket_id' },
          );
      }
    } catch (err) {
      console.warn('[slack] chat.postMessage error:', err);
    }
    return true;
  }

  // Webhook fallback for one-way installs. Override Slack's default
  // channel if the integration specifies one.
  const body: any = { ...payload };
  if (integration.channel) body.channel = integration.channel;

  try {
    const res = await fetch(integration.webhook_url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[slack] post returned ${res.status}: ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    console.warn('[slack] post failed:', err);
  }
  return true;
}

async function getThreadMapping(sb: SupabaseClient, workspaceId: string, ticketId: string) {
  const { data } = await sb
    .from('slack_thread_mappings')
    .select('channel_id, thread_ts')
    .eq('workspace_id', workspaceId)
    .eq('ticket_id', ticketId)
    .maybeSingle();
  return data;
}
