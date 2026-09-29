import { loadDraftRecipients, saveDraftRecipients } from './drafts.js';

export function emailDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(date) : '';
}
export function messageTime(message) {
  const email = message.email;
  const label = email?.status === 'sent' ? 'Sent' : email?.status === 'received' ? 'Received' : email?.status === 'saved' ? 'Saved · not emailed' : 'Added';
  const date = emailDate(email?.status === 'sent' ? email.sent_at : email?.received_at || message.createdAt);
  return date ? `${label} ${date}` : message.ts || '';
}
export function renderEmailDetails(message) {
  const e = message.email;
  if (!e) return '';
  const esc = window.escHtml;
  const row = (label, value) => value ? `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '';
  const recipients = [...(e.to || []), ...(e.cc || [])];
  const fields = row('From', e.from) + row('To', (e.to || []).join(', ')) + row('CC', (e.cc || []).join(', '))
    + row('Reply to', e.reply_to && e.reply_to !== e.from ? e.reply_to : '')
    + row('Sender fallback', e.used_fallback_from ? 'Sent from the platform address; replies go to the selected inbox.' : '')
    + row('Sent by sender', e.status === 'received' ? emailDate(e.sent_at) : '');
  return `<div class="message-email-details">${e.status === 'received' ? `<div class="email-inbox">Received via <strong>${esc(e.received_via || 'Inbox not recorded')}</strong></div>` : ''}
    ${recipients.length > 3 ? `<details><summary>Email details · ${recipients.length} recipients</summary><dl>${fields}</dl></details>` : `<dl>${fields}</dl>`}</div>`;
}
export function replyDraft(ticket) {
  const saved = loadDraftRecipients(ticket.id);
  const inbox = ticket.replyRecipients?.sending_inboxes?.find(inbox => inbox.id === ticket.replyRecipients.default_sending_channel_id);
  return { sending_channel_id: inbox?.id || null, sending_address: inbox?.address || null, ...(saved || { mode: 'reply', source_message_id: ticket.replyRecipients?.source_message_id || null,
    to: ticket.replyRecipients?.to || [], cc: '' }) };
}
export function renderReplyRecipients(ticket) {
  if (!ticket._uuid || !ticket.replyRecipients) return '';
  const draft = replyDraft(ticket), id = window.escAttr(ticket.id);
  const stale = draft.source_message_id !== ticket.replyRecipients.source_message_id || JSON.stringify(draft.to) !== JSON.stringify(ticket.replyRecipients.to);
  const inboxes = ticket.replyRecipients.sending_inboxes || [];
  const unavailable = draft.sending_channel_id && !inboxes.some(inbox => inbox.id === draft.sending_channel_id && inbox.address === draft.sending_address);
  return `<div class="reply-recipients">
    <label for="reply-from-${id}">From</label><select id="reply-from-${id}" data-change-action="td.replyFrom" data-ticket-id="${id}">
      <option value="" ${!draft.sending_channel_id ? 'selected' : ''}>Workspace default${ticket.replyRecipients.default_from ? ` — ${window.escHtml(ticket.replyRecipients.default_from)}` : ''}</option>
      ${unavailable ? `<option value="${window.escAttr(draft.sending_channel_id)}" selected disabled>Previously selected inbox unavailable — choose another</option>` : ''}
      ${inboxes.map(inbox => `<option value="${window.escAttr(inbox.id)}" ${!unavailable && draft.sending_channel_id === inbox.id ? 'selected' : ''}>${window.escHtml(inbox.address)}</option>`).join('')}
    </select>
    <label for="reply-mode-${id}">Action</label><select id="reply-mode-${id}" data-change-action="td.replyMode" data-ticket-id="${id}">
      <option value="reply" ${draft.mode === 'reply' ? 'selected' : ''}>Reply</option><option value="reply_all" ${draft.mode === 'reply_all' ? 'selected' : ''}>Reply all</option></select>
    <span>To</span><span class="reply-to">${window.escHtml(draft.to.join(', ') || 'No email recipient')}</span>
    <label for="reply-cc-${id}">CC</label><input id="reply-cc-${id}" type="email" multiple value="${window.escAttr(draft.cc)}" placeholder="Add email addresses, separated by commas" data-input-action="td.replyCc" data-ticket-id="${id}" aria-describedby="reply-recipient-hint-${id}">
    <small id="reply-recipient-hint-${id}">${stale ? `This draft uses earlier recipients. <button type="button" class="btn btn-sm" data-action="td.refreshRecipients" data-ticket-id="${id}">Use latest recipients</button>` : 'Check who will receive this email before sending.'}</small>
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
