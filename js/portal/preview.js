// ─── Customer Portal preview ─────────────────────────────────────────────────
// "What does the end customer see?" surface area. Agents pick a customer to
// preview as; the portal then renders a simplified end-customer experience
// (their tickets only, public messages only, ability to reply or open new
// tickets). Mutations write to the real ticket data so the demo flows
// end-to-end with the agent view.
//
// State (PORTAL_*) is module-internal — no other code reads it. The
// portal's "switch customer" / "exit preview" flow goes through
// portalSetCustomer(null) → renderPortalCustomerPicker rather than
// touching CUSTOMER_SELECTED in state.js.
//
// Click handlers route through core/event-delegation.js. `renderPortal` is
// the only export consumed (app.js's router).

import { CUSTOMERS, KB_ARTICLES, TICKETS } from '../core/data.js';
import { renderPage, updateNavBadges } from '../core/router.js';
import { refreshTicketSLA } from '../tickets/sla.js';
import { logTicketEvent } from '../core/activity-log.js';
import { fireWebhook, ticketPayload } from '../webhooks/index.js';
import { applyAssignmentRules } from '../tickets/assignment-rules.js';
import { registerActions } from '../core/event-delegation.js';
import { navTo } from '../core/keybindings.js';

let PORTAL_CUSTOMER_ID = null;
let PORTAL_VIEW = 'tickets';
let PORTAL_TICKET_ID = null;

function portalSetCustomer(id) {
  PORTAL_CUSTOMER_ID = id || null;
  PORTAL_VIEW = 'tickets';
  PORTAL_TICKET_ID = null;
  renderPage('portal');
}

function portalExit() {
  PORTAL_CUSTOMER_ID = null;
  PORTAL_TICKET_ID = null;
  navTo('dashboard');
}

function portalNav(view) {
  PORTAL_VIEW = view;
  if (view !== 'ticket') PORTAL_TICKET_ID = null;
  renderPage('portal');
}

function portalOpenTicket(id) {
  PORTAL_TICKET_ID = id;
  PORTAL_VIEW = 'ticket';
  renderPage('portal');
}

function portalSendReply(ticketId) {
  const el = document.getElementById('portal-reply');
  if (!el) return;
  const txt = el.value.trim();
  if (!txt) return;
  const t = TICKETS.find(x => x.id === ticketId);
  const cust = CUSTOMERS.find(c => c.id === PORTAL_CUSTOMER_ID);
  if (!t || !cust) return;
  t.msgs = t.msgs || [];
  t.msgs.push({
    from: `${cust.first} ${cust.last}`,
    r: 'customer',
    t: txt,
    ts: new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }),
  });
  // Reopen if the customer replies on a resolved ticket — matches typical
  // portal behaviour and lets the agent flow react to follow-ups.
  if (t.status === 'resolved') {
    logTicketEvent(ticketId, 'status', `Status: resolved → open (customer reply via portal)`);
    t.status = 'open';
    refreshTicketSLA(t);
    updateNavBadges();
  }
  renderPage('portal');
}

function portalCreateTicket() {
  const cust = CUSTOMERS.find(c => c.id === PORTAL_CUSTOMER_ID);
  if (!cust) return;
  const subj = document.getElementById('portal-subj').value.trim();
  const body = document.getElementById('portal-body').value.trim();
  const cat  = document.getElementById('portal-cat').value;
  if (!subj) { alert('Please add a subject.'); return; }
  // Scan max(id) instead of TICKETS.length so deletions/merges don't produce a
  // colliding ID. Same pattern as slaNextId / macNextId / arNextId.
  const max = Math.max(0, ...TICKETS.map(x => parseInt((x.id || '').split('-')[1] || '0', 10)));
  const newId = 'TK-' + String(max + 1).padStart(3, '0');
  const newT = {
    id: newId, subject: subj, customerId: cust.id,
    status: 'open', priority: 'normal', category: cat || 'Technical',
    agent: '', created: new Date().toISOString().slice(0, 10), updated: 'just now',
    sla: 'ok', tags: [], aiTags: [], csat: null,
    msgs: body ? [{ from: `${cust.first} ${cust.last}`, r: 'customer', t: body, ts: new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }) }] : [],
  };
  TICKETS.unshift(newT);
  applyAssignmentRules(newT);
  refreshTicketSLA(newT);
  fireWebhook('ticket.created', ticketPayload(newT));
  updateNavBadges();
  PORTAL_TICKET_ID = newId;
  PORTAL_VIEW = 'ticket';
  renderPage('portal');
}

export function renderPortal() {
  if (!PORTAL_CUSTOMER_ID) return renderPortalCustomerPicker();
  const cust = CUSTOMERS.find(c => c.id === PORTAL_CUSTOMER_ID);
  if (!cust) {
    PORTAL_CUSTOMER_ID = null;
    return renderPortalCustomerPicker();
  }
  const banner = `
    <div class="portal-banner">
      <span style="font-size:14px">🔍</span>
      <span>Portal preview · viewing as ${window.escHtml(cust.first + ' ' + cust.last)}</span>
      <span style="margin-left:auto;display:flex;gap:6px">
        <button class="btn btn-sm" data-action="portal.setCustomer">Switch customer</button>
        <button class="btn btn-sm" data-action="portal.exit">Exit preview</button>
      </span>
    </div>`;
  const tabs = `
    <div class="portal-tabs">
      <div class="portal-tab ${PORTAL_VIEW==='tickets' || PORTAL_VIEW==='ticket' ? 'active' : ''}" data-action="portal.nav" data-view="tickets">My tickets</div>
      <div class="portal-tab ${PORTAL_VIEW==='new' ? 'active' : ''}" data-action="portal.nav" data-view="new">New ticket</div>
      <div class="portal-tab ${PORTAL_VIEW==='kb' ? 'active' : ''}" data-action="portal.nav" data-view="kb">Knowledge base</div>
      <div class="portal-tab ${PORTAL_VIEW==='profile' ? 'active' : ''}" data-action="portal.nav" data-view="profile">My profile</div>
    </div>`;
  let body = '';
  if (PORTAL_VIEW === 'ticket' && PORTAL_TICKET_ID) body = renderPortalTicket(cust, PORTAL_TICKET_ID);
  else if (PORTAL_VIEW === 'new')     body = renderPortalNewTicket(cust);
  else if (PORTAL_VIEW === 'kb')      body = renderPortalKB();
  else if (PORTAL_VIEW === 'profile') body = renderPortalProfile(cust);
  else                                body = renderPortalTicketList(cust);
  return `<div class="page">${banner}${tabs}<div class="page-scroll" style="padding:18px 20px">${body}</div></div>`;
}

function renderPortalCustomerPicker() {
  const cards = CUSTOMERS.map(c => {
    const ticketN = TICKETS.filter(t => t.customerId === c.id).length;
    return `
      <div class="portal-card" data-action="portal.setCustomer" data-cust-id="${window.escAttr(c.id)}" style="display:flex;align-items:center;gap:14px">
        <div style="width:42px;height:42px;border-radius:50%;background:var(--ink);color:var(--w);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0">${window.escHtml((c.first[0] + c.last[0]).toUpperCase())}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--ink)">${window.escHtml(c.first + ' ' + c.last)}</div>
          <div style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;margin-top:2px">${window.escHtml(c.id)} · ${window.escHtml(c.brand || '')} · ${ticketN} ticket${ticketN===1?'':'s'}</div>
        </div>
        <span class="vip-badge vip-${(c.vip || '').toLowerCase()}" style="margin-left:auto">${window.escHtml(c.vip || '')}</span>
      </div>`;
  }).join('');
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Customer Portal Preview</div>
      </div>
      <div class="page-scroll" style="padding:18px 20px">
        <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Pick a customer to preview their portal. The simulated experience uses real ticket data — replies and new tickets created from preview write through to the agent view.</div>
        <div style="max-width:600px">${cards}</div>
      </div>
    </div>`;
}

function renderPortalTicketList(cust) {
  const tickets = TICKETS.filter(t => t.customerId === cust.id && !t.mergedInto)
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  if (!tickets.length) {
    return `<div style="text-align:center;padding:40px 0;color:var(--ink3);font-size:13px">No tickets yet. <span class="link" data-action="portal.nav" data-view="new">Open a new ticket</span> to get help.</div>`;
  }
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:600;color:var(--ink)">My tickets</div>
      <button class="btn btn-solid btn-sm" data-action="portal.nav" data-view="new">+ New ticket</button>
    </div>
    ${tickets.map(t => {
      const lastMsg = (t.msgs || []).filter(m => m.r !== 'note').slice(-1)[0];
      const lastPreview = lastMsg ? (lastMsg.t.length > 100 ? lastMsg.t.slice(0, 100) + '…' : lastMsg.t) : '';
      const statusLabel = t.status === 'resolved' ? 'Resolved'
        : t.status === 'pending' ? 'Awaiting your reply'
        : t.status === 'escalated' ? 'Escalated · being handled'
        : 'In progress';
      return `
        <div class="portal-card" data-action="portal.openTicket" data-ticket-id="${window.escAttr(t.id)}">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${window.escHtml(t.id)}</span>
            <span style="font-size:11px;color:${t.status==='resolved'?'var(--green)':t.status==='pending'?'var(--amber)':'var(--blue)'};font-weight:600;text-transform:uppercase;letter-spacing:.06em">${window.escHtml(statusLabel)}</span>
            <span style="margin-left:auto;font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">opened ${window.escHtml(t.created || '—')}</span>
          </div>
          <div style="font-size:14px;font-weight:600;color:var(--ink);margin-bottom:6px">${window.escHtml(t.subject)}</div>
          ${lastPreview ? `<div style="font-size:12px;color:var(--ink2);font-style:italic;line-height:1.4">${window.escHtml(lastPreview)}</div>` : ''}
        </div>`;
    }).join('')}`;
}

function renderPortalTicket(cust, ticketId) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t || t.customerId !== cust.id) {
    return `<div style="color:var(--ink3);font-size:12px;text-align:center;padding:30px">Ticket not found. <span class="link" data-action="portal.nav" data-view="tickets">Back to my tickets</span></div>`;
  }
  // Public messages only — internal notes never reach the customer.
  const publicMsgs = (t.msgs || []).filter(m => m.r !== 'note');
  const msgsHtml = publicMsgs.map(m => `
    <div style="display:flex;flex-direction:column;margin-bottom:10px">
      <div class="${m.r === 'customer' ? 'portal-msg-customer' : 'portal-msg-agent'}">
        <div style="font-size:10px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;font-weight:600">${window.escHtml(m.from)} · ${window.escHtml(m.ts)}</div>
        ${window.escHtml(m.t).replace(/\n/g, '<br>')}
      </div>
    </div>`).join('');
  const closed = t.status === 'resolved';
  return `
    <div style="margin-bottom:10px"><span class="link" data-action="portal.nav" data-view="tickets" style="font-size:12px">← My tickets</span></div>
    <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:600;color:var(--ink);margin-bottom:6px">${window.escHtml(t.subject)}</div>
    <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-bottom:18px">${window.escHtml(t.id)} · ${closed ? 'Resolved' : 'In progress'}${t.agent ? ' · Helping you: ' + window.escHtml(t.agent) : ''}</div>
    <div style="display:flex;flex-direction:column;margin-bottom:18px">${msgsHtml || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px">No messages yet</div>'}</div>
    <div style="border-top:1px solid var(--rule);padding-top:14px">
      <label class="form-label">${closed ? 'Reopen with a reply' : 'Reply'}</label>
      <textarea class="form-input" id="portal-reply" rows="4" placeholder="${closed ? 'Type your reply — sending will reopen the ticket.' : 'Type your reply…'}"></textarea>
      <div style="margin-top:10px;text-align:right"><button class="btn btn-solid btn-sm" data-action="portal.sendReply" data-ticket-id="${window.escAttr(t.id)}">Send</button></div>
    </div>`;
}

function renderPortalNewTicket(cust) {
  const cats = [...new Set(TICKETS.map(t => t.category))];
  return `
    <div style="max-width:560px">
      <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:600;color:var(--ink);margin-bottom:6px">Open a new ticket</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:18px;line-height:1.5">Tell us what's going on and we'll get back to you. Hi ${window.escHtml(cust.first)} 👋</div>
      <div class="form-row"><label class="form-label">Subject</label><input class="form-input" id="portal-subj" placeholder="Brief description of the issue"/></div>
      <div class="form-row"><label class="form-label">Category</label>
        <select class="form-input" id="portal-cat">${cats.map(c => `<option value="${window.escAttr(c)}">${window.escHtml(c)}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label class="form-label">Describe what's happening</label>
        <textarea class="form-input" id="portal-body" rows="6" placeholder="Steps to reproduce, what you expected, what happened…"></textarea>
      </div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn" data-action="portal.nav" data-view="tickets">Cancel</button>
        <button class="btn btn-solid btn-sm" data-action="portal.createTicket">Submit ticket</button>
      </div>
    </div>`;
}

function renderPortalKB() {
  const articles = (typeof KB_ARTICLES !== 'undefined' ? KB_ARTICLES : []).slice(0, 12);
  if (!articles.length) {
    return `<div style="color:var(--ink3);font-size:12px;text-align:center;padding:30px">No knowledge-base articles available.</div>`;
  }
  return `
    <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:600;color:var(--ink);margin-bottom:14px">Help articles</div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">
      ${articles.map(a => `
        <div class="portal-card portal-card--static">
          <div style="font-size:10px;color:var(--purple);text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:6px">${window.escHtml(a.category || '')}</div>
          <div style="font-size:14px;font-weight:600;color:var(--ink);margin-bottom:6px">${window.escHtml(a.title || '')}</div>
          <div style="font-size:12px;color:var(--ink2);line-height:1.5">${window.escHtml((a.summary || a.body || '').slice(0, 140))}…</div>
        </div>`).join('')}
    </div>`;
}

function renderPortalProfile(cust) {
  return `
    <div style="max-width:520px">
      <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:600;color:var(--ink);margin-bottom:14px">My profile</div>
      <div class="portal-card portal-card--static">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
          <div style="width:50px;height:50px;border-radius:50%;background:var(--ink);color:var(--w);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600">${window.escHtml((cust.first[0] + cust.last[0]).toUpperCase())}</div>
          <div>
            <div style="font-size:15px;font-weight:600;color:var(--ink)">${window.escHtml(cust.first + ' ' + cust.last)}</div>
            <div style="font-size:12px;color:var(--ink3);font-family:'DM Mono',monospace">${window.escHtml(cust.id)}</div>
          </div>
        </div>
        ${cust.email    ? `<div style="font-size:12px;color:var(--ink2);margin-bottom:4px"><strong>Email:</strong> ${window.escHtml(cust.email)}</div>` : ''}
        ${cust.brand    ? `<div style="font-size:12px;color:var(--ink2);margin-bottom:4px"><strong>Brand:</strong> ${window.escHtml(cust.brand)}</div>` : ''}
        ${cust.vip      ? `<div style="font-size:12px;color:var(--ink2);margin-bottom:4px"><strong>Tier:</strong> ${window.escHtml(cust.vip)}</div>` : ''}
        ${cust.jurisdiction ? `<div style="font-size:12px;color:var(--ink2);margin-bottom:4px"><strong>Region:</strong> ${window.escHtml(cust.jurisdiction)}</div>` : ''}
      </div>
    </div>`;
}

registerActions({
  // `ds.custId` is undefined for the "Switch customer" button (no
  // data-cust-id attr) — that resolves to null, matching the original
  // `portalSetCustomer(null)` semantics.
  'portal.setCustomer':  (ds) => portalSetCustomer(ds.custId || null),
  'portal.exit':         () => portalExit(),
  'portal.nav':          (ds) => portalNav(ds.view),
  'portal.openTicket':   (ds) => portalOpenTicket(ds.ticketId),
  'portal.sendReply':    (ds) => portalSendReply(ds.ticketId),
  'portal.createTicket': () => portalCreateTicket(),
});
