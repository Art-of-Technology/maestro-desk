import { hasContact } from './contacts.js';
import { renderEmailNameMismatch } from '../tickets/email-details.js';

export function renderCustomerEmailNames(customer, tickets) {
  if (customer.erased || customer.mergedInto || customer._mergedIntoUuid) return '';
  const seen = new Set(), rows = [];
  for (const ticket of tickets.filter(t => t.customerId === customer.id)) {
    for (const message of ticket.msgs || []) {
      const address = String(message.email?.from || '').trim(), name = String(message.from || '').trim();
      if (message.r !== 'customer' || message.email?.status !== 'received' || message.forwarded || message.mergedFrom
          || !hasContact(customer, 'email', address) || !name || name.toLowerCase() === address.toLowerCase()) continue;
      const key = JSON.stringify([address.toLowerCase(), name.normalize('NFC').replace(/\s+/g, ' ').toLowerCase()]);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push('<li><strong>' + window.escHtml(name) + '</strong> · ' + window.escHtml(address)
        + '<span class="email-name-comparison">' + renderEmailNameMismatch(message, customer) + '</span></li>');
    }
  }
  return '<section class="card customer-email-names"><div class="card-title">Email sender names</div>'
    + (customer.maestroUserId ? '<p>Player account: ' + window.escHtml([customer.first, customer.last].filter(Boolean).join(' ') || 'Name unavailable') + '</p>' : '')
    + '<p>Names observed in loaded conversations. These do not verify email ownership.</p>'
    + (rows.length ? '<ul>' + rows.join('') + '</ul>' : '<p>No email sender names available in loaded conversations.</p>') + '</section>';
}
