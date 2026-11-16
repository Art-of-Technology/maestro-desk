import { hasContact } from './contacts.js';
import { renderEmailNameMismatch } from '../tickets/email-details.js';

export function renderEmailNames(names, canReview = false) {
  const esc = window.escHtml;
  const rows = (names?.entries || []).map(entry => `<div class="contact-name-entry">
    <dl><dt>Email sender name</dt><dd>${esc(entry.sender_name || 'Not available')}<small>${esc(entry.email)}</small></dd></dl>
    ${entry.mismatch && !entry.reviewed ? `<p class="contact-name-warning"><span aria-hidden="true">⚠</span> Names differ — check before responding.</p>
      ${canReview && entry.review_key ? `<button type="button" class="btn btn-sm" data-action="customerHistory.reviewName" data-permission="customers.edit tickets.view_all" data-review-key="${window.escAttr(entry.review_key)}">Mark as reviewed</button>` : ''}` : ''}
    ${entry.reviewed ? `<details class="contact-name-reviewed"><summary>Reviewed by ${esc(entry.reviewed.by)} · ${esc(new Date(entry.reviewed.at).toLocaleString('en-GB'))}</summary><p>${esc(entry.reviewed.reason)}</p></details>` : ''}
  </div>`).join('');
  return `<section class="card customer-email-names"><div class="card-title">Name comparison</div>
    <dl><dt>Account holder name</dt><dd>${esc(names?.account_holder_name || 'No registered name available')}</dd></dl>
    ${rows || '<p>No email addresses available.</p>'}
    <small>Sender names are supplied with emails; they do not verify ownership.</small>
  </section>`;
}

export function renderCustomerEmailNames(customer, tickets) {
  if (customer.erased || customer.mergedInto || customer._mergedIntoUuid) return '';
  if (customer._uuid) return '<div data-history-email-names><section class="card customer-email-names"><div class="card-title">Name comparison</div><p role="status">Loading names…</p></section></div>';
  const seen = new Set(), entries = [];
  for (const ticket of tickets.filter(t => t.customerId === customer.id)) {
    for (const message of ticket.msgs || []) {
      const address = String(message.email?.from || '').trim(), name = String(message.from || '').trim();
      if (message.r !== 'customer' || message.email?.status !== 'received' || message.forwarded || message.mergedFrom
          || !hasContact(customer, 'email', address) || !name || name.toLowerCase() === address.toLowerCase()) continue;
      const key = JSON.stringify([address.toLowerCase(), name.normalize('NFC').replace(/\s+/g, ' ').toLowerCase()]);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ email: address, sender_name: name, mismatch: !!renderEmailNameMismatch(message, customer) });
    }
  }
  return renderEmailNames({ account_holder_name: customer.maestroUserId ? [customer.first, customer.last].filter(Boolean).join(' ') : null, entries });
}
