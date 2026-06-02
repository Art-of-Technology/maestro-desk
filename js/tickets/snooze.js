// ─── Snooze ──────────────────────────────────────────────────────────────────
// Snoozing pauses a ticket until a chosen wall-clock time. While snoozed:
//  - SLA evaluation returns 'snoozed' instead of running the timers
//  - The ticket shows a "💤 snoozed until X" indicator in the list and detail
// On wake (snoozedUntil <= now), checkSnoozeWakeups clears the fields, logs
// an event, refreshes SLA, and stamps snoozeWokenAt so a wake notification
// shows in the bell for ~24h.
//
// External reaches (interim, via window):
// logTicketEvent, renderPage, showModal, escHtml, closeModal. All
// still live in app.js and are bridged. openTicket, refreshNotifBadge and
// refreshTicketSLA are direct ES imports.
//
// SESSION, CURRENT_TICKET, CURRENT_PAGE, TICKET_SELECTED_IDS come from
// core/state.js via the global lexical env.
//
// No window-bridge namespace: unsnooze + showSnoozeModal are consumed by
// tickets/detail.js (td.unsnooze / td.snooze) and formatSnoozeUntil by
// detail.js + list.js, all via direct ES import; checkSnoozeWakeups is
// called by app.js's wakeup timer. The inline handlers — the preset chips
// and the list-page "Snooze…" bulk button — are delegated as snooze.preset
// and snooze.bulkSnooze below. snooze.bulkSnooze fires from a data-action
// rendered by tickets/list.js but is owned here (this module owns the fn).

import { refreshNotifBadge } from '../notifications/index.js';
import { logTicketEvent } from '../core/activity-log.js';
import { openTicket } from './detail.js';
import { refreshTicketSLA } from './sla.js';
import { apiPost, apiDelete } from '../core/api-client.js';
import { registerActions } from '../core/event-delegation.js';
import { showModal, closeModal } from '../core/modal.js';

async function snoozeTicket(id, untilIso, reason) {
  const t = TICKETS.find(x => x.id === id);
  if (!t || !untilIso) return;
  const until = new Date(untilIso);
  if (isNaN(until.getTime()) || until.getTime() <= Date.now()) {
    alert('Snooze time must be in the future.');
    return;
  }
  if (t._uuid) {
    try { await apiPost(`/api/v1/tickets/${t._uuid}/snooze`, { until: until.toISOString(), reason: reason || null }); }
    catch (err) { alert(`Couldn't snooze: ${err?.message || err}`); return; }
  }
  t.snoozedUntil = until.toISOString();
  t.snoozedAt = new Date().toISOString();
  t.snoozedBy = SESSION?.name || 'Agent';
  t.snoozeReason = reason || null;
  delete t.snoozeWokenAt;
  refreshTicketSLA(t);
  logTicketEvent(id, 'system', `Snoozed until ${formatSnoozeUntil(t.snoozedUntil)}${reason ? ' · ' + reason : ''}`);
  if (CURRENT_TICKET === id) openTicket(id);
  else window.renderPage(CURRENT_PAGE || 'tickets');
  refreshNotifBadge();
}

export async function unsnoozeTicket(id, viaWakeup) {
  const t = TICKETS.find(x => x.id === id);
  if (!t || !t.snoozedUntil) return;
  if (t._uuid) {
    try { await apiDelete(`/api/v1/tickets/${t._uuid}/snooze?via_wakeup=${viaWakeup ? 'true' : 'false'}`); }
    catch (err) {
      // Auto-wake (viaWakeup=true) shouldn't bother the user with an alert
      // — the next poll will retry. Manual unsnooze gets the alert.
      if (!viaWakeup) alert(`Couldn't clear snooze: ${err?.message || err}`);
      return;
    }
  }
  delete t.snoozedUntil;
  delete t.snoozedAt;
  delete t.snoozedBy;
  delete t.snoozeReason;
  if (viaWakeup) t.snoozeWokenAt = new Date().toISOString();
  refreshTicketSLA(t);
  logTicketEvent(id, 'system', viaWakeup ? 'Snooze elapsed — ticket woke up' : 'Snooze cleared by agent');
  if (CURRENT_TICKET === id) openTicket(id);
  refreshNotifBadge();
}

export function checkSnoozeWakeups() {
  const now = Date.now();
  let anyWoke = false;
  TICKETS.forEach(t => {
    if (t.snoozedUntil && new Date(t.snoozedUntil).getTime() <= now) {
      unsnoozeTicket(t.id, true);
      anyWoke = true;
    }
  });
  if (anyWoke && CURRENT_PAGE === 'tickets' && !CURRENT_TICKET) window.renderPage('tickets');
  return anyWoke;
}

export function formatSnoozeUntil(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return 'now';
  const min = Math.round(ms / 60000);
  if (min < 60)   return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24)    return `in ${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  if (days < 7)   return `in ${days}d`;
  return d.toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
}

function snoozePresetIso(key) {
  const d = new Date();
  if (key === '1h')   { d.setHours(d.getHours() + 1); return d.toISOString(); }
  if (key === '4h')   { d.setHours(d.getHours() + 4); return d.toISOString(); }
  if (key === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }
  if (key === 'monday') {
    const wd = d.getDay(); // 0=Sun
    const daysUntilMonday = (8 - wd) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMonday);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }
  // Unknown key: fall back to +4h so callers can chain .slice() safely.
  d.setHours(d.getHours() + 4);
  return d.toISOString();
}

export function showSnoozeModal(ticketId) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t) return;
  const presets = [
    { key:'1h',       label:'1 hour' },
    { key:'4h',       label:'4 hours' },
    { key:'tomorrow', label:'Tomorrow 9:00' },
    { key:'monday',   label:'Next Monday 9:00' },
  ];
  const pillRow = presets.map(p => `
    <button type="button" class="btn btn-sm" style="flex:1" data-action="snooze.preset" data-key="${p.key}">${p.label}</button>`).join('');
  const defaultIso = snoozePresetIso('4h').slice(0, 16);
  showModal(`Snooze ${window.escHtml(t.id)}`, `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:12px;line-height:1.5">SLA evaluation pauses while snoozed. The ticket wakes itself when the time is reached and posts a notification.</div>
    <div class="form-row"><label class="form-label">Quick presets</label>
      <div style="display:flex;gap:6px">${pillRow}</div>
    </div>
    <div class="form-row"><label class="form-label">Until</label>
      <input class="form-input" type="datetime-local" id="snz-when" value="${defaultIso}"/>
    </div>
    <div class="form-row"><label class="form-label">Reason (optional)</label>
      <input class="form-input" id="snz-reason" placeholder="e.g. Awaiting customer reply"/>
    </div>
  `, () => {
    const when = document.getElementById('snz-when').value;
    if (!when) { alert('Pick a wake-up time.'); return; }
    const reason = document.getElementById('snz-reason').value.trim();
    snoozeTicket(ticketId, new Date(when).toISOString(), reason);
    closeModal();
  }, 'Snooze');
}

function bulkSnoozeTickets() {
  if (TICKET_SELECTED_IDS.size === 0) return;
  const n = TICKET_SELECTED_IDS.size;
  const presets = [
    { key:'1h',       label:'1 hour' },
    { key:'4h',       label:'4 hours' },
    { key:'tomorrow', label:'Tomorrow 9:00' },
    { key:'monday',   label:'Next Monday 9:00' },
  ];
  const pillRow = presets.map(p => `
    <button type="button" class="btn btn-sm" style="flex:1" data-action="snooze.preset" data-key="${p.key}">${p.label}</button>`).join('');
  const defaultIso = snoozePresetIso('4h').slice(0, 16);
  showModal(`Snooze ${n} ticket${n===1?'':'s'}`, `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:12px;line-height:1.5">Each ticket gets the same wake-up time. Already-snoozed tickets are overwritten.</div>
    <div class="form-row"><label class="form-label">Quick presets</label>
      <div style="display:flex;gap:6px">${pillRow}</div>
    </div>
    <div class="form-row"><label class="form-label">Until</label>
      <input class="form-input" type="datetime-local" id="snz-when" value="${defaultIso}"/>
    </div>
    <div class="form-row"><label class="form-label">Reason (optional)</label>
      <input class="form-input" id="snz-reason" placeholder="e.g. Awaiting customer reply"/>
    </div>
  `, () => {
    const when = document.getElementById('snz-when').value;
    if (!when) { alert('Pick a wake-up time.'); return; }
    const iso = new Date(when).toISOString();
    const reason = document.getElementById('snz-reason').value.trim();
    [...TICKET_SELECTED_IDS].forEach(id => snoozeTicket(id, iso, reason));
    TICKET_SELECTED_IDS.clear();
    closeModal();
    window.renderPage('tickets');
  }, 'Snooze');
}

registerActions({
  'snooze.preset':     (ds) => { const el = document.getElementById('snz-when'); if (el) el.value = snoozePresetIso(ds.key).slice(0, 16); },
  'snooze.bulkSnooze': () => bulkSnoozeTickets(),
});
