// ─── Inbox (incoming email triage) ───────────────────────────────────────────
// Synthetic-email triage surface. New emails from the seeded INBOX list show
// up here; agents either convert each to a ticket, dismiss it, or mark it
// spam. The "converted" status carries a back-reference to the resulting
// ticket so the inbox row can deep-link into the ticket detail.
//
// Convert-to-ticket blocks when no customer record matches the email's
// fromEmail — silently attaching to CUSTOMERS[0] would mis-attribute the
// ticket. The detail pane shows a contextual prompt to add the customer
// first (or fall back to Tickets → + New Ticket with manual paste).
//
// Click/change handlers route through core/event-delegation.js as
// `data-action="inbox.*"` / `data-change-action="inbox.*"`.
//
// External reaches (interim, via window): updateNavBadges,
// fireWebhook, ticketPayload, applyAssignmentRules, escHtml, escAttr — all
// still in app.js. openTicket, navTo, refreshTicketSLA are direct ES imports.
//
// INBOX, TICKETS, CUSTOMERS, CHANNELS come from data.js; INBOX_SELECTED_ID,
// INBOX_FILTER_STATUS, INBOX_FILTER_CHANNEL, CUSTOMER_SELECTED come from
// state.js (the latter is mutated inline from the customer-match deep-link).

import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { openTicket } from '../tickets/detail.js';
import { navTo } from '../core/keybindings.js';
import { refreshTicketSLA } from '../tickets/sla.js';

function dismissEmail(emailId) {
  const e = INBOX.find(x => x.id === emailId);
  if (!e) return;
  e.status = 'dismissed';
  e.actedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  if (INBOX_SELECTED_ID === emailId) INBOX_SELECTED_ID = null;
  window.updateNavBadges();
  window.renderPage('inbox');
}

function markSpamEmail(emailId) {
  const e = INBOX.find(x => x.id === emailId);
  if (!e) return;
  e.status = 'spam';
  e.actedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  if (INBOX_SELECTED_ID === emailId) INBOX_SELECTED_ID = null;
  window.updateNavBadges();
  window.renderPage('inbox');
}

function restoreEmail(emailId) {
  const e = INBOX.find(x => x.id === emailId);
  if (!e || e.status === 'converted') return;
  e.status = 'new';
  delete e.actedAt;
  window.updateNavBadges();
  window.renderPage('inbox');
}

function convertEmailToTicket(emailId) {
  const e = INBOX.find(x => x.id === emailId);
  if (!e) return;
  const cust = CUSTOMERS.find(c => (c.email || '').toLowerCase() === (e.fromEmail || '').toLowerCase());
  // Block conversion when no customer matches — silently attaching to
  // CUSTOMERS[0] would mis-attribute the ticket. Force the agent to either
  // create a customer record first or pick one explicitly via the new-ticket
  // form. The dialog explains the situation rather than just refusing.
  if (!cust) {
    alert(`No customer record matches ${e.fromEmail}.\n\nCreate the customer first (Customers → + New Customer) or use Tickets → + New Ticket and paste this email's content manually. The email will stay in the inbox until you handle it.`);
    return;
  }
  const channel = CHANNELS.find(c => c.id === e.channelId);
  const max = Math.max(0, ...TICKETS.map(x => parseInt((x.id || '').split('-')[1] || '0', 10)));
  const newId = 'TK-' + String(max + 1).padStart(3, '0');
  const cats = [...new Set(TICKETS.map(x => x.category).filter(Boolean))];
  const fallbackCat = cats.includes('Technical') ? 'Technical' : (cats[0] || 'Technical');
  const newT = {
    id: newId,
    subject: e.subject || '(no subject)',
    customerId: cust.id,
    status: 'open',
    priority: 'normal',
    category: (channel?.defaultCategory && channel.defaultCategory !== 'all') ? channel.defaultCategory : fallbackCat,
    agent: channel?.defaultAgent || '',
    created: new Date().toISOString().slice(0, 10),
    updated: 'just now',
    sla: 'ok', tags: [], aiTags: [], csat: null,
    msgs: [{
      from: `${cust.first} ${cust.last}`,
      r: 'customer',
      t: e.body || '',
      ts: (e.receivedAt || '').slice(11, 16) || new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }),
    }],
    fromEmailId: e.id,
    fromChannelId: e.channelId,
  };
  TICKETS.unshift(newT);
  if (!newT.agent && typeof window.applyAssignmentRules === 'function') window.applyAssignmentRules(newT);
  refreshTicketSLA(newT);
  window.fireWebhook('ticket.created', { ...window.ticketPayload(newT), source: 'inbox', emailId: e.id });
  e.status = 'converted';
  e.convertedTicketId = newId;
  e.actedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  window.updateNavBadges();
  openTicket(newId);
}

export function renderInbox() {
  const channelOpts = ['all', ...CHANNELS.filter(c => c.type === 'email' || c.type === 'webform').map(c => c.id)];
  let list = [...INBOX];
  if (INBOX_FILTER_STATUS  !== 'all') list = list.filter(e => e.status === INBOX_FILTER_STATUS);
  if (INBOX_FILTER_CHANNEL !== 'all') list = list.filter(e => e.channelId === INBOX_FILTER_CHANNEL);
  list.sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));
  // If the previously-selected email is no longer in the filtered view, drop
  // the selection so the detail pane reverts to the empty placeholder rather
  // than showing an item that's hidden in the list.
  if (INBOX_SELECTED_ID && !list.some(e => e.id === INBOX_SELECTED_ID)) INBOX_SELECTED_ID = null;

  const total    = INBOX.length;
  const newN     = INBOX.filter(e => e.status === 'new').length;
  const convN    = INBOX.filter(e => e.status === 'converted').length;
  const dismN    = INBOX.filter(e => e.status === 'dismissed').length;
  const spamN    = INBOX.filter(e => e.status === 'spam').length;

  const selected = INBOX_SELECTED_ID ? INBOX.find(e => e.id === INBOX_SELECTED_ID) : null;

  const channelMap = {};
  CHANNELS.forEach(c => channelMap[c.id] = c);

  const rowFor = e => {
    const ch = channelMap[e.channelId];
    const isSelected = e.id === INBOX_SELECTED_ID;
    const isUnread = e.status === 'new';
    const cust = CUSTOMERS.find(c => (c.email || '').toLowerCase() === (e.fromEmail || '').toLowerCase());
    return `
      <div class="inbox-row ${isSelected ? 'inbox-row-selected' : ''} ${isUnread ? 'inbox-row-unread' : 'inbox-row-read'}" data-action="inbox.select" data-email-id="${window.escAttr(e.id)}">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:3px">
          <span style="font-size:13px;color:var(--ink);${isUnread ? 'font-weight:600' : 'font-weight:400'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${window.escHtml(e.from || 'Unknown')}</span>
          <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);flex-shrink:0">${window.escHtml(e.receivedAt || '')}</span>
        </div>
        <div style="font-size:12px;color:${isUnread ? 'var(--ink)' : 'var(--ink2)'};${isUnread ? 'font-weight:500' : ''};margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(e.subject || '(no subject)')}</div>
        <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--ink3)">
          <span style="font-family:'DM Mono',monospace">${window.escHtml(e.fromEmail || '')}</span>
          ${ch ? `<span style="margin-left:auto;font-size:10px;color:var(--purple);background:var(--purple-lt);padding:1px 6px;border-radius:3px">${window.escHtml(ch.name)}</span>` : ''}
          ${cust ? `<span style="font-size:10px;color:var(--green);background:var(--green-lt);padding:1px 6px;border-radius:3px" title="Match: ${window.escAttr(cust.first + ' ' + cust.last)}">✓ ${window.escHtml(cust.id)}</span>` : `<span style="font-size:10px;color:var(--ink3);font-style:italic">no customer match</span>`}
          ${e.status === 'converted' && e.convertedTicketId ? `<span style="font-size:10px;color:var(--green);font-family:'DM Mono',monospace">→ ${window.escHtml(e.convertedTicketId)}</span>` : ''}
          ${e.status === 'dismissed' ? '<span style="font-size:10px;color:var(--ink3);font-style:italic">dismissed</span>' : ''}
          ${e.status === 'spam' ? '<span style="font-size:10px;color:var(--red);font-style:italic">spam</span>' : ''}
        </div>
      </div>`;
  };

  const detailHtml = selected ? (() => {
    const ch = channelMap[selected.channelId];
    const cust = CUSTOMERS.find(c => (c.email || '').toLowerCase() === (selected.fromEmail || '').toLowerCase());
    const isActed = selected.status !== 'new';
    return `
      <div class="card" style="padding:18px 20px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:14px">
          <div style="flex:1;min-width:0">
            <div style="font-size:16px;font-weight:600;color:var(--ink);margin-bottom:4px">${window.escHtml(selected.subject || '(no subject)')}</div>
            <div style="font-size:11px;color:var(--ink2)">From <strong style="color:var(--ink)">${window.escHtml(selected.from || 'Unknown')}</strong> &lt;${window.escHtml(selected.fromEmail || '')}&gt;</div>
            <div style="font-size:11px;color:var(--ink3);margin-top:2px;font-family:'DM Mono',monospace">${window.escHtml(selected.receivedAt || '')} · via ${window.escHtml(ch?.name || selected.channelId)}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap">
            ${selected.status === 'new'
              ? `<button class="btn btn-sm btn-solid" data-action="inbox.convert" data-email-id="${window.escAttr(selected.id)}">→ Convert to ticket</button>
                 <button class="btn btn-sm" data-action="inbox.dismiss" data-email-id="${window.escAttr(selected.id)}">Dismiss</button>
                 <button class="btn btn-sm btn-danger" data-action="inbox.spam" data-email-id="${window.escAttr(selected.id)}">Spam</button>`
              : selected.status === 'converted'
                ? `<button class="btn btn-sm" data-action="inbox.openTicket" data-ticket-id="${window.escAttr(selected.convertedTicketId)}">Open ${window.escHtml(selected.convertedTicketId)}</button>`
                : `<button class="btn btn-sm" data-action="inbox.restore" data-email-id="${window.escAttr(selected.id)}">Restore</button>`}
          </div>
        </div>
        ${cust ? `<div style="margin-bottom:14px;padding:10px 12px;background:var(--green-lt);border:1px solid var(--green);border-radius:var(--r);font-size:11px;color:var(--green);display:flex;gap:8px;align-items:center">
          <span style="font-weight:600">Customer matched</span>
          <span class="link" data-action="inbox.openCustomer" data-customer-id="${window.escAttr(cust.id)}" style="color:var(--green);font-weight:500">${window.escHtml(cust.first + ' ' + cust.last)}</span>
          <span class="vip-badge vip-${(cust.vip || '').toLowerCase()}" style="margin-left:auto">${window.escHtml(cust.vip || '')}</span>
        </div>` : `<div style="margin-bottom:14px;padding:10px 12px;background:var(--amber-lt);border:1px solid var(--amber);border-radius:var(--r);font-size:11px;color:var(--amber);display:flex;gap:8px;align-items:center">
          <span style="font-weight:600">No customer match</span>
          <span style="color:var(--ink2);font-style:italic">${window.escHtml(selected.fromEmail || '')} isn't in the customer list — convert is blocked. Add the customer first via <span class="link" data-action="inbox.gotoCustomers" style="color:var(--amber);font-weight:500">Customers → + New Customer</span>.</span>
        </div>`}
        <div style="font-size:13px;color:var(--ink);line-height:1.65;white-space:pre-wrap;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);padding:14px 16px">${window.escHtml(selected.body || '')}</div>
        ${isActed ? `<div style="margin-top:14px;font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${selected.status} ${selected.actedAt ? '· ' + window.escHtml(selected.actedAt) : ''}</div>` : ''}
      </div>`;
  })() : `
    <div style="display:flex;align-items:center;justify-content:center;color:var(--ink3);font-size:12px;font-style:italic;padding:40px 0;border:1px dashed var(--rule);border-radius:var(--r)">Select an email to read it</div>`;

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Inbox</div>
        <span style="font-size:11px;color:var(--ink3);font-style:italic">Incoming mail across email and webform channels — convert into tickets, dismiss, or mark spam.</span>
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n c-blue">${newN}</div><div class="kpi-l">New</div></div>
        <div class="kpi"><div class="kpi-n c-green">${convN}</div><div class="kpi-l">Converted</div></div>
        <div class="kpi"><div class="kpi-n">${dismN}</div><div class="kpi-l">Dismissed</div></div>
        <div class="kpi"><div class="kpi-n c-red">${spamN}</div><div class="kpi-l">Spam</div></div>
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Total</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Channel</span>
        <select class="filter-select" data-change-action="inbox.setFilterChannel">
          ${channelOpts.map(id => id === 'all'
            ? `<option value="all" ${INBOX_FILTER_CHANNEL==='all'?'selected':''}>All channels</option>`
            : `<option value="${window.escAttr(id)}" ${INBOX_FILTER_CHANNEL===id?'selected':''}>${window.escHtml(channelMap[id]?.name || id)}</option>`).join('')}
        </select>
        <span class="filter-label" style="margin-left:8px">Status</span>
        <select class="filter-select" data-change-action="inbox.setFilterStatus">
          <option value="new"       ${INBOX_FILTER_STATUS==='new'?'selected':''}>New (${newN})</option>
          <option value="converted" ${INBOX_FILTER_STATUS==='converted'?'selected':''}>Converted (${convN})</option>
          <option value="dismissed" ${INBOX_FILTER_STATUS==='dismissed'?'selected':''}>Dismissed (${dismN})</option>
          <option value="spam"      ${INBOX_FILTER_STATUS==='spam'?'selected':''}>Spam (${spamN})</option>
          <option value="all"       ${INBOX_FILTER_STATUS==='all'?'selected':''}>All</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        <div style="display:grid;grid-template-columns:380px 1fr;gap:14px">
          <div style="overflow-y:auto;max-height:calc(100vh - 280px);padding-right:4px">
            ${list.length ? list.map(rowFor).join('') : `<div style="color:var(--ink3);font-size:12px;text-align:center;padding:40px 0;font-style:italic">No emails match the current filters</div>`}
          </div>
          <div>${detailHtml}</div>
        </div>
      </div>
    </div>`;
}

registerActions({
  'inbox.select':         (ds) => { INBOX_SELECTED_ID = ds.emailId; window.renderPage('inbox'); },
  'inbox.convert':        (ds) => convertEmailToTicket(ds.emailId),
  'inbox.dismiss':        (ds) => dismissEmail(ds.emailId),
  'inbox.spam':           (ds) => markSpamEmail(ds.emailId),
  'inbox.restore':        (ds) => restoreEmail(ds.emailId),
  'inbox.openTicket':     (ds) => openTicket(ds.ticketId),
  'inbox.openCustomer':   (ds) => { CUSTOMER_SELECTED = ds.customerId; navTo('customers'); },
  'inbox.gotoCustomers':  () => navTo('customers'),
});

registerChangeActions({
  'inbox.setFilterChannel': (ds, el) => { INBOX_FILTER_CHANNEL = el.value; window.renderPage('inbox'); },
  'inbox.setFilterStatus':  (ds, el) => { INBOX_FILTER_STATUS  = el.value; window.renderPage('inbox'); },
});
