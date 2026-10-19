import { loadDraftRecipients, saveDraftRecipients } from './drafts.js';

export function emailDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(date) : '';
}
export function messageTime(message) {
  const email = message.email;
  const label = message.forwarded ? (email?.status === 'sent' ? 'Forwarded' : email?.forward_state === 'unknown' || email?.forward_state === 'sending' ? 'Forward · delivery unconfirmed' : 'Forward · not sent') : email?.status === 'sent' ? 'Sent' : email?.status === 'received' ? 'Received' : email?.status === 'saved' ? 'Saved · not emailed' : 'Added';
  const deliveryLabel = !message.forwarded && email?.status === 'saved' && ['sending', 'preparing', 'unknown'].includes(email.delivery_state)
    ? email.delivery_state === 'unknown' ? 'Delivery unconfirmed' : 'Sending' : label;
  const recipients = [...new Set([...(email?.to || []), ...(email?.cc || [])].map(address => address.toLowerCase()))];
  const delivered = recipients.filter(address => email?.delivered_recipients?.[address]).length;
  const confirmedLabel = email?.status === 'sent' && delivered
    ? delivered === recipients.length ? 'Delivered' : 'Partially delivered' : deliveryLabel;
  const date = emailDate(email?.status === 'sent' ? email.sent_at : email?.received_at || message.createdAt);
  return date ? `${confirmedLabel} ${date}` : message.ts || '';
}
export function renderEmailRetry(message) {
  if (!message._uuid || message.r !== 'agent' || message.forwarded || message.mergedFrom || message.email?.status !== 'saved') return '';
  if (message.email.delivery_state === 'failed') return `<button type="button" class="btn btn-sm" data-action="emailRetry.send" data-message-id="${window.escAttr(message._uuid)}">Retry sending</button>`;
  if (message.email.delivery_state === 'unknown') return '<p role="status">Delivery could not be confirmed. Check delivery before sending again.</p>';
  return '';
}
export function renderEmailDetails(message) {
  const e = message.email;
  if (!e) return '';
  const esc = window.escHtml;
  const row = (label, value) => value ? `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '';
  const recipients = [...(e.status === 'received' ? [] : e.to || []), ...(e.cc || [])];
  const fields = row('From', e.from) + row('To', e.status === 'received' ? '' : (e.to || []).join(', ')) + row('CC', (e.cc || []).join(', '))
    + row('Delivery confirmed', Object.entries(e.delivered_recipients || {}).map(([address, at]) => `${address}: ${emailDate(at)}`).join('; '))
    + row('Reply to', e.reply_to && e.reply_to !== e.from ? e.reply_to : '')
    + row('Sender fallback', e.used_fallback_from ? 'Sent from the platform address; replies go to the selected inbox.' : '')
    + row('Sent by sender', e.status === 'received' ? emailDate(e.sent_at) : '');
  return `<div class="message-email-details">${e.status === 'received' ? `<div class="email-inbox">Received via <strong>${esc(e.received_via || 'Inbox not recorded')}</strong></div>` : ''}
    ${recipients.length > 3 ? `<details><summary>Email details · ${recipients.length} recipients</summary><dl>${fields}</dl></details>` : `<dl>${fields}</dl>`}</div>`;
}
export function replyDraft(ticket) {
  const saved = loadDraftRecipients(ticket.id);
  const inbox = ticket.replyRecipients?.sending_inboxes?.find(inbox => inbox.id === (ticket.channelId || ticket.replyRecipients.default_sending_channel_id));
  const sender = { sending_channel_id: inbox?.id || null, sending_address: inbox?.address || null };
  const moved = saved && Object.hasOwn(saved, 'ticket_channel_id') && (saved.ticket_channel_id || null) !== (ticket.channelId || null);
  return { ...sender, ...(saved || { mode: 'reply', source_message_id: ticket.replyRecipients?.source_message_id || null,
    to: ticket.replyRecipients?.to || [], cc: '' }), ...(moved ? sender : {}), ticket_channel_id: ticket.channelId || null };
}
export function renderReplyRecipients(ticket) {
  if (!ticket._uuid || !ticket.replyRecipients) return '';
  const draft = replyDraft(ticket), id = window.escAttr(ticket.id);
  const stale = draft.source_message_id !== ticket.replyRecipients.source_message_id || JSON.stringify(draft.to) !== JSON.stringify(ticket.replyRecipients.to);
  const inboxes = ticket.replyRecipients.sending_inboxes || [];
  const unavailable = draft.sending_channel_id && !inboxes.some(inbox => inbox.id === draft.sending_channel_id && inbox.address === draft.sending_address);
  const ccVisible = Boolean(draft.cc.trim());
  return `<div class="reply-recipients">
    <div class="reply-sender-row">
    <label for="reply-from-${id}">From</label><select id="reply-from-${id}" data-change-action="td.replyFrom" data-ticket-id="${id}">
      <option value="" ${!draft.sending_channel_id ? 'selected' : ''}>Workspace default${ticket.replyRecipients.default_from ? ` — ${window.escHtml(ticket.replyRecipients.default_from)}` : ''}</option>
      ${unavailable ? `<option value="${window.escAttr(draft.sending_channel_id)}" selected disabled>Previously selected inbox unavailable — choose another</option>` : ''}
      ${inboxes.map(inbox => `<option value="${window.escAttr(inbox.id)}" ${!unavailable && draft.sending_channel_id === inbox.id ? 'selected' : ''}>${window.escHtml(inbox.address)}</option>`).join('')}
    </select>
    <select id="reply-mode-${id}" aria-label="Reply mode" data-change-action="td.replyMode" data-ticket-id="${id}">
      <option value="reply" ${draft.mode === 'reply' ? 'selected' : ''}>Reply</option><option value="reply_all" ${draft.mode === 'reply_all' ? 'selected' : ''}>Reply all</option></select>
    </div>
    <div class="reply-address-row">
    <span>To</span><span class="reply-to">${window.escHtml(draft.to.join(', ') || 'No email recipient')}</span>
    <button type="button" class="btn btn-sm reply-cc-toggle" data-action="td.toggleReplyCc" data-ticket-id="${id}" aria-label="Cc recipients" aria-expanded="${ccVisible}" aria-controls="reply-cc-field-${id}">Cc</button>
    </div>
    <div class="reply-cc-field" id="reply-cc-field-${id}" ${ccVisible ? '' : 'hidden'}>
    <label for="reply-cc-${id}">Cc</label><input id="reply-cc-${id}" type="email" multiple value="${window.escAttr(draft.cc)}" placeholder="Email addresses, separated by commas" data-input-action="td.replyCc" data-ticket-id="${id}">
    </div>
    ${stale ? `<small class="reply-recipient-warning" role="status">This draft uses earlier recipients. <button type="button" class="btn btn-sm" data-action="td.refreshRecipients" data-ticket-id="${id}">Use latest recipients</button></small>` : ''}
  </div>`;
}
export function changeReplyMode(ticket, mode) {
  const draft = replyDraft(ticket);
  // Switching action starts with the latest email's recipients; the body stays intact.
  saveDraftRecipients(ticket.id, { ...draft, mode, source_message_id: ticket.replyRecipients.source_message_id,
    to: ticket.replyRecipients.to, cc: mode === 'reply_all' ? ticket.replyRecipients.cc.join(', ') : '' });
}
export function replyRecipientPayload(ticket) {
  if (!ticket.replyRecipients) return undefined;
  const draft = replyDraft(ticket);
  return { ...draft, cc: draft.cc.split(',').map(e => e.trim()).filter(Boolean) };
}
