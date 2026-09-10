// ─── Notifications ───────────────────────────────────────────────────────────
// Two surfaces share the same notification stream:
//
//   1. The bell dropdown in the top bar — quick glance, click an entry to
//      jump to the ticket. Rendered into #notif-dropdown by renderNotifications.
//
//   2. The full Notifications page (sidebar nav) — type/read filters,
//      Mark read / Dismiss per entry, Mark all read, Clear all.
//
// Notifications themselves aren't stored — getNotifications() derives the
// current list from live ticket state each call. NOTIFICATIONS_READ and
// NOTIFICATIONS_DISMISSED track per-id flags inside the module (not
// persisted; resets on reload, same as ticket state).
//
// Click/change/mousedown handlers route through core/event-delegation.js.
// Bell-dropdown actions use mousedown rather than click so they fire before
// core/dismiss.js (which also listens on mousedown) sees outside-clicks.
//
// External reaches (interim, via window): escAttr, setSettingsTab — still in
// app.js (notifications calls window.setSettingsTab to dodge the
// settings↔notifications import cycle). navTo and openTicket are direct ES
// imports.
//
// The bell button in static index.html dispatches the notif.toggle action
// (registered below); toggleNotifications and the rest of this module's API
// are module-internal now.

import { TICKETS } from '../core/data.js';
import { NOTIF_PREFS, SESSION, CURRENT_TICKET } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { registerActions, registerChangeActions, registerMousedownActions } from '../core/event-delegation.js';
import { navTo } from '../core/keybindings.js';
import { openTicket } from '../tickets/detail.js';
import { showModal, closeModal } from '../core/modal.js';
import { showToast } from '../core/toast.js';
import { getWorkspaceId, getJwt } from '../core/api-client.js';
import { workQueueState, loadWorkQueue } from '../tickets/work-queue.js';
import { unassignedNotifications } from './unassigned.js';
// setSettingsTab is reached via window to avoid a notifications↔settings
// import cycle (settings imports refreshNotifBadge from here). Settings is
// still bridged; this can become a direct import once Settings migrates.

const NOTIFICATIONS_READ = new Set();
const NOTIFICATIONS_DISMISSED = new Set();
let NOTIF_PAGE_FILTER_TYPE = 'all';
let NOTIF_PAGE_FILTER_READ = 'all';
let notificationContext = null;
let surfaceSignature = null;

function queueNotice() {
  const state = workQueueState();
  if (state.ready) return '';
  return state.error
    ? '<div role="status" style="padding:14px">Could not check unassigned tickets. <button class="btn btn-sm" data-action="notif.retry">Retry</button></div>'
    : '<div role="status" style="padding:14px">Checking unassigned tickets…</div>';
}

function getNotifications() {
  const context = `${getWorkspaceId() || ''}:${getJwt() || ''}:${SESSION?.name || ''}`;
  if (notificationContext !== context) {
    notificationContext = context;
    NOTIFICATIONS_READ.clear();
    NOTIFICATIONS_DISMISSED.clear();
  }
  const out = [];
  if (workQueueState().ready) {
    const unassigned = unassignedNotifications(TICKETS);
    const currentIds = new Set(unassigned.map(n => n.id));
    // A later return to the unassigned queue is a fresh alert. Do not clear
    // flags while an index is incomplete or a request has failed.
    for (const flags of [NOTIFICATIONS_READ, NOTIFICATIONS_DISMISSED]) {
      for (const id of flags) if (id.startsWith('unassigned-') && !currentIds.has(id)) flags.delete(id);
    }
    if (NOTIF_PREFS.unassigned !== false) {
      out.push(...unassigned.filter(n => !NOTIFICATIONS_DISMISSED.has(n.id)));
    }
  }
  const wakeWindowMs = 24 * 60 * 60 * 1000;
  // Mentions of the current session user across all tickets — emit before per-ticket
  // status notifications so they're not crowded out when an SLA breach also exists.
  if (SESSION?.name && NOTIF_PREFS.mention !== false) {
    for (const t of TICKETS) {
      (t.msgs || []).forEach((m, i) => {
        if (m.r !== 'note' || !m.mentions) return;
        // mentions are stored in two shapes depending on origin:
        //   API-fetched messages  → array of UUID strings
        //   Just-posted via SPA   → array of {name, userId, role} objects
        // The old check only handled neither correctly (compared a
        // name string against either UUIDs or objects). Handle both
        // shapes so the bell badge actually fires for real-auth users.
        const userMentioned = m.mentions.some((x) => {
          if (typeof x === 'string') {
            return SESSION.userId ? x === SESSION.userId : false;
          }
          if (x && typeof x === 'object') {
            return (SESSION.userId && x.userId === SESSION.userId)
                || x.name === SESSION.name;
          }
          return false;
        });
        if (!userMentioned) return;
        if (m.from === SESSION.name) return;
        const mid = `mention-${t.id}-${i}`;
        if (NOTIFICATIONS_DISMISSED.has(mid)) return;
        out.push({id:mid, type:'mention', color:'var(--purple)', title:`Mentioned by ${m.from}`, body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:m.ts});
      });
    }
  }
  for (const t of TICKETS) {
    let n = null;
    // Snooze wake-up takes priority for ~24h after firing so an agent doesn't miss it.
    if (t.snoozeWokenAt && NOTIF_PREFS.wake !== false && (Date.now() - new Date(t.snoozeWokenAt).getTime()) < wakeWindowMs) {
      n = {id:'wake-'+t.id, type:'wake', color:'var(--blue)', title:'Snooze elapsed', body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:t.updated};
    } else if (t.sla === 'breach' && NOTIF_PREFS.breach) {
      n = {id:'breach-'+t.id, type:'breach', color:'var(--red)', title:'SLA breach', body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:t.updated};
    } else if (t.status === 'escalated' && NOTIF_PREFS.escalated) {
      n = {id:'esc-'+t.id, type:'escalated', color:'var(--escalate)', title:'Escalated', body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:t.updated};
    } else if (t.status === 'gdpr' && NOTIF_PREFS.gdpr) {
      n = {id:'gdpr-'+t.id, type:'gdpr', color:'var(--red)', title:'GDPR request', body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:t.updated};
    } else if (t.sla === 'warn' && NOTIF_PREFS.warn) {
      n = {id:'warn-'+t.id, type:'warn', color:'var(--amber)', title:'SLA warning', body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:t.updated};
    } else if (NOTIF_PREFS.response !== false && awaitingMyReply(t)) {
      // Lowest priority in the chain: a more urgent signal (breach/escalated/
      // gdpr/warn) on the same ticket takes the slot and already surfaces it.
      n = {id:'response-'+t.id, type:'response', color:'var(--cyan)', title:'New customer reply', body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:t.updated};
    }
    if (n && !NOTIFICATIONS_DISMISSED.has(n.id)) out.push(n);
  }
  return out;
}

// "Awaiting my reply" — an open/escalated ticket assigned to me whose latest
// message is from the customer (and not currently snoozed). lastMessageRole
// comes from the list endpoint; fall back to the loaded thread for demo
// personas (whose seeded tickets carry msgs but no server field).
function lastRoleOf(t) {
  if (t.lastMessageRole) return t.lastMessageRole;
  const m = t.msgs && t.msgs.length ? t.msgs[t.msgs.length - 1] : null;
  return m ? m.r : null;
}
function awaitingMyReply(t) {
  if (!SESSION?.name || t.agent !== SESSION.name) return false;
  if (t.status !== 'open' && t.status !== 'escalated') return false;
  if (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now()) return false;
  return lastRoleOf(t) === 'customer';
}

// Per-ticket snapshot of the last-seen latest-message role, so the realtime
// push toasts ONCE on the transition into "awaiting my reply" rather than on
// every unrelated change to a ticket that's already awaiting a reply.
const RESPONSE_SEEN = new Map();   // ticket uuid → last-seen lastMessageRole

// Called by the realtime ticket.changed handler AFTER the list delta-sync has
// updated TICKETS. Fires a transient toast for a newly-arrived customer reply
// on a ticket assigned to me, unless I'm already viewing it.
export function maybeToastNewResponse(ticketUuid) {
  if (NOTIF_PREFS.response === false || !SESSION?.name) return;
  const t = TICKETS.find((x) => x._uuid === ticketUuid);
  if (!t) return;
  const role = lastRoleOf(t);
  const prev = RESPONSE_SEEN.get(ticketUuid);
  RESPONSE_SEEN.set(ticketUuid, role);
  if (role !== 'customer' || prev === 'customer') return;   // only the transition into customer-latest
  if (!awaitingMyReply(t)) return;                          // assigned to me, open, not snoozed
  refreshNotifBadge();                                      // reflect the new awaiting-reply item in the bell
  if (t.id === CURRENT_TICKET) return;                      // already open on screen — the thread reload covers it
  showToast(`💬 New reply on ${t.id} — ${t.subject}`, 'info', 6000, () => openTicket(t.id));
}

export function refreshNotifBadge() {
  const items = getNotifications();
  const state = workQueueState();
  const signature = JSON.stringify([notificationContext, state.ready, state.error, items, [...NOTIFICATIONS_READ]]);
  if (signature !== surfaceSignature) {
    surfaceSignature = signature;
    if (document.getElementById('notif-dropdown')?.classList.contains('show')) renderNotifications();
    if (document.body.dataset.currentPage === 'notifications') renderPage('notifications');
  }
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const n = items.filter(x => !NOTIFICATIONS_READ.has(x.id)).length;
  badge.textContent = !state.ready ? (state.error ? '?' : '…') : n > 9 ? '9+' : String(n);
  badge.title = !state.ready ? (state.error ? 'Could not check unassigned tickets' : 'Checking unassigned tickets') : `${n} unread notifications`;
  badge.style.display = n > 0 || !state.ready ? 'flex' : 'none';
}

function renderNotifications() {
  const dd = document.getElementById('notif-dropdown');
  if (!dd) return;
  const items = getNotifications();
  const unread = items.filter(n => !NOTIFICATIONS_READ.has(n.id));
  let html = `
    <div class="notif-head">
      <div class="notif-title">Notifications ${items.length ? `<span class="notif-count">${unread.length} unread · ${items.length} total</span>` : ''}</div>
      ${unread.length ? `<div class="notif-mark" data-mousedown-action="notif.markAllRead">Mark all read</div>` : ''}
    </div>`;
  html += queueNotice();
  if (!items.length) {
    if (workQueueState().ready) html += `<div class="notif-empty">All caught up — no notifications.</div>`;
  } else {
    html += items.map(n => `
      <button type="button" class="notif-item ${NOTIFICATIONS_READ.has(n.id)?'read':''}" style="width:100%;text-align:left;font:inherit;color:inherit;border:0;border-bottom:1px solid var(--rule)" data-action="notif.openFromDropdown" data-notif-id="${window.escAttr(n.id)}" data-ticket-id="${window.escAttr(n.ticketId)}">
        <span class="notif-dot" style="background:${n.color}"></span>
        <span class="notif-body">
          <span class="notif-row"><span class="notif-name">${window.escHtml(n.title)}</span><span class="notif-time">${window.escHtml(n.ts || '')}</span></span>
          <span class="notif-text" style="display:block">${window.escHtml(n.body)}</span>
        </span>
      </button>`).join('');
    html += `<div style="padding:10px 14px;border-top:1px solid var(--rule);text-align:center;background:var(--off2);position:sticky;bottom:0"><span class="link" data-mousedown-action="notif.closeAndGo" style="font-size:11px;font-weight:500">View all notifications →</span></div>`;
  }
  dd.innerHTML = html;
}

function closeNotifAndGo() {
  document.getElementById('notif-dropdown')?.classList.remove('show');
  document.getElementById('notif-btn')?.classList.remove('active');
  navTo('notifications');
}

function toggleNotifications() {
  const dd = document.getElementById('notif-dropdown');
  const btn = document.getElementById('notif-btn');
  if (!dd) return;
  if (dd.classList.contains('show')) {
    dd.classList.remove('show');
    btn?.classList.remove('active');
    return;
  }
  renderNotifications();
  dd.classList.add('show');
  btn?.classList.add('active');
}

function openNotification(notifId, ticketId) {
  NOTIFICATIONS_READ.add(notifId);
  const dd = document.getElementById('notif-dropdown');
  dd?.classList.remove('show');
  document.getElementById('notif-btn')?.classList.remove('active');
  refreshNotifBadge();
  if (ticketId) openTicket(ticketId);
}

function markAllNotifRead() {
  getNotifications().forEach(n => NOTIFICATIONS_READ.add(n.id));
  refreshNotifBadge();
  renderNotifications();
}

function markNotifRead(id) {
  NOTIFICATIONS_READ.add(id);
  refreshNotifBadge();
  renderPage('notifications');
}

function dismissNotif(id) {
  NOTIFICATIONS_DISMISSED.add(id);
  refreshNotifBadge();
  renderPage('notifications');
}

function clearAllNotifications() {
  showModal('Clear notifications', '<div style="font-size:13px;color:var(--ink2);line-height:1.6">Dismiss all current notifications? They will be removed from the bell and the notifications page.</div>', () => {
    getNotifications().forEach(n => NOTIFICATIONS_DISMISSED.add(n.id));
    refreshNotifBadge();
    closeModal(); renderPage('notifications');
  }, 'Clear all');
}

function openNotificationFromPage(id, ticketId) {
  NOTIFICATIONS_READ.add(id);
  refreshNotifBadge();
  if (ticketId) openTicket(ticketId);
}

function markAllNotifReadAndRender() {
  markAllNotifRead();
  renderPage('notifications');
}

export function renderNotificationsPage() {
  const all = getNotifications();
  let list = [...all];
  if (NOTIF_PAGE_FILTER_TYPE !== 'all') list = list.filter(n => n.type === NOTIF_PAGE_FILTER_TYPE);
  if (NOTIF_PAGE_FILTER_READ === 'unread') list = list.filter(n => !NOTIFICATIONS_READ.has(n.id));
  if (NOTIF_PAGE_FILTER_READ === 'read')   list = list.filter(n =>  NOTIFICATIONS_READ.has(n.id));

  const total = all.length;
  const unread = all.filter(n => !NOTIFICATIONS_READ.has(n.id)).length;
  const read = total - unread;
  const types = { breach:0, escalated:0, gdpr:0, warn:0, response:0, unassigned:0 };
  all.forEach(n => { if (types[n.type] !== undefined) types[n.type]++; });
  const highPri = types.breach + types.escalated + types.gdpr;

  const items = list.map(n => {
    const isRead = NOTIFICATIONS_READ.has(n.id);
    return `
      <div style="display:flex;flex-wrap:wrap;gap:12px;padding:14px;border:1px solid var(--rule);border-radius:var(--r);background:${isRead?'var(--off2)':'var(--off)'};transition:all .15s;align-items:stretch">
        <div style="width:4px;border-radius:2px;background:${n.color};flex-shrink:0;align-self:stretch"></div>
        <button type="button" style="flex:1 1 180px;min-width:0;min-height:44px;cursor:pointer;text-align:left;font:inherit;background:transparent;border:0;padding:0" data-action="notif.openFromPage" data-notif-id="${window.escAttr(n.id)}" data-ticket-id="${window.escAttr(n.ticketId)}">
          <span style="display:flex;gap:10px;align-items:center;margin-bottom:4px">
            <span style="font-size:13px;font-weight:600;color:var(--ink)">${window.escHtml(n.title)}</span>
            ${!isRead ? '<span style="width:6px;height:6px;border-radius:50%;background:var(--purple);box-shadow:0 0 6px var(--purple);flex-shrink:0"></span>' : ''}
            <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${window.escHtml(n.ts || '')}</span>
          </span>
          <span style="display:block;font-size:12.5px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(n.body)}</span>
        </button>
        <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center" data-action="">
          ${!isRead ? `<button class="btn btn-sm" data-action="notif.markRead" data-notif-id="${window.escAttr(n.id)}" title="Mark read">Mark read</button>` : ''}
          <button class="btn btn-sm btn-danger" data-action="notif.dismiss" data-notif-id="${window.escAttr(n.id)}" title="Dismiss">Dismiss</button>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Notifications</div>
        ${unread ? `<button class="btn btn-sm" data-action="notif.markAllReadPage">Mark all read</button>` : ''}
        ${total ? `<button class="btn btn-sm btn-danger" data-action="notif.clearAll">Clear all</button>` : ''}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Total</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${unread}</div><div class="kpi-l">Unread</div></div>
        <div class="kpi"><div class="kpi-n c-green">${read}</div><div class="kpi-l">Read</div></div>
        <div class="kpi"><div class="kpi-n c-red">${highPri}</div><div class="kpi-l">High priority</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <select class="filter-select" data-change-action="notif.setFilterType">
          <option value="all"       ${NOTIF_PAGE_FILTER_TYPE==='all'?'selected':''}>All types</option>
          <option value="breach"    ${NOTIF_PAGE_FILTER_TYPE==='breach'?'selected':''}>SLA breach (${types.breach})</option>
          <option value="escalated" ${NOTIF_PAGE_FILTER_TYPE==='escalated'?'selected':''}>Escalated (${types.escalated})</option>
          <option value="gdpr"      ${NOTIF_PAGE_FILTER_TYPE==='gdpr'?'selected':''}>GDPR (${types.gdpr})</option>
          <option value="warn"      ${NOTIF_PAGE_FILTER_TYPE==='warn'?'selected':''}>SLA warning (${types.warn})</option>
          <option value="response"  ${NOTIF_PAGE_FILTER_TYPE==='response'?'selected':''}>New responses (${types.response})</option>
          <option value="unassigned" ${NOTIF_PAGE_FILTER_TYPE==='unassigned'?'selected':''}>Unassigned (${types.unassigned})</option>
        </select>
        <select class="filter-select" data-change-action="notif.setFilterRead">
          <option value="all"    ${NOTIF_PAGE_FILTER_READ==='all'?'selected':''}>All statuses</option>
          <option value="unread" ${NOTIF_PAGE_FILTER_READ==='unread'?'selected':''}>Unread only</option>
          <option value="read"   ${NOTIF_PAGE_FILTER_READ==='read'?'selected':''}>Read only</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        ${queueNotice()}
        ${list.length === 0
          ? (workQueueState().ready ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">${total === 0 ? 'All caught up — no notifications' : 'No notifications match the filters'}</div><div class="empty-line"></div></div>` : '')
          : `<div style="display:flex;flex-direction:column;gap:8px">${items}</div>
             <div style="font-size:11px;color:var(--ink3);text-align:center;margin-top:18px;line-height:1.6">Notifications are computed live from ticket state. Configure which types appear in <span class="link" data-action="notif.gotoSettingsNotif">Settings → Notifications</span>.</div>`}
      </div>
    </div>`;
}

registerActions({
  'notif.retry': async () => {
    const pending = loadWorkQueue();
    refreshNotifBadge();
    await pending;
    refreshNotifBadge();
  },
  // top-bar bell button in static index.html
  'notif.toggle':          () => toggleNotifications(),
  'notif.openFromDropdown': (ds) => openNotification(ds.notifId, ds.ticketId),
  'notif.openFromPage':    (ds) => openNotificationFromPage(ds.notifId, ds.ticketId),
  'notif.markRead':        (ds) => markNotifRead(ds.notifId),
  'notif.dismiss':         (ds) => dismissNotif(ds.notifId),
  'notif.markAllReadPage': () => markAllNotifReadAndRender(),
  'notif.clearAll':        () => clearAllNotifications(),
  'notif.gotoSettingsNotif': () => { navTo('settings'); window.setSettingsTab('notifications'); },
});

registerChangeActions({
  'notif.setFilterType': (ds, el) => { NOTIF_PAGE_FILTER_TYPE = el.value; renderPage('notifications'); },
  'notif.setFilterRead': (ds, el) => { NOTIF_PAGE_FILTER_READ = el.value; renderPage('notifications'); },
});

registerMousedownActions({
  'notif.markAllRead':      () => markAllNotifRead(),
  'notif.openFromDropdown': (ds) => openNotification(ds.notifId, ds.ticketId),
  'notif.closeAndGo':       () => closeNotifAndGo(),
});
