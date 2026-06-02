// ─── Time tracking ───────────────────────────────────────────────────────────
// Each ticket can carry a timeEntries[] of {id, agent, minutes, note, ts, billable}.
// Entries roll up into per-ticket totals shown in the sidebar, per-agent and
// per-customer totals in reports, and a CSV column on tickets export.
//
// External reaches (interim, via window):
//   • fmtMinutes      — number formatter, still in app.js
//   • isAdmin         — auth helper, still in app.js
//   • logTicketEvent  — activity-log writer, still in app.js
//   • openTicket      — composer/detail render, direct ES import (tickets/detail.js)
//   • showModal, escHtml, closeModal — modal infra, still in app.js
//
// SESSION and CURRENT_TICKET come from core/state.js via the global lexical env.
//
// No window-bridge namespace: every export is consumed via direct ES import
// (reports/list/detail for the totals; detail.js for removeTimeEntry /
// showLogTimeModal via td.removeTime / td.logTime). The one inline handler
// (the minutes quick-preset) is delegated as tt.preset below.

import { apiPost, apiDelete } from '../core/api-client.js';
import { logTicketEvent } from '../core/activity-log.js';
import { openTicket } from './detail.js';
import { registerActions } from '../core/event-delegation.js';
import { showModal, closeModal } from '../core/modal.js';

function timeEntryNextId() {
  return 'TE-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function fmtEntryTs(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 16).replace('T', ' ');
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function ticketTotalMinutes(t) {
  return (t?.timeEntries || []).reduce((s, e) => s + (e.minutes || 0), 0);
}

export function ticketBillableMinutes(t) {
  return (t?.timeEntries || []).filter(e => e.billable !== false).reduce((s, e) => s + (e.minutes || 0), 0);
}

export async function addTimeEntry(ticketId, minutes, note, billable) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t) return;
  const m = parseInt(minutes, 10);
  if (!Number.isFinite(m) || m <= 0) { alert('Enter a positive number of minutes.'); return; }
  if (!t.timeEntries) t.timeEntries = [];
  const trimmedNote = (note || '').trim() || null;
  const isBillable = billable !== false;
  let entry;
  if (t._uuid) {
    let resp;
    try {
      resp = await apiPost(`/api/v1/tickets/${t._uuid}/time`, { minutes: m, note: trimmedNote, billable: isBillable });
    } catch (err) { alert(`Couldn't log time: ${err?.message || err}`); return; }
    entry = {
      id:       resp.entry.id,
      agent:    resp.entry.user_name || SESSION?.name || 'Agent',
      minutes:  resp.entry.minutes,
      note:     resp.entry.note,
      billable: resp.entry.billable,
      ts:       fmtEntryTs(resp.entry.created_at),
    };
  } else {
    entry = {
      id:       timeEntryNextId(),
      agent:    SESSION?.name || 'Agent',
      minutes:  m,
      note:     trimmedNote,
      billable: isBillable,
      ts:       fmtEntryTs(),
    };
  }
  t.timeEntries.unshift(entry);
  logTicketEvent(ticketId, 'system', `Logged ${window.fmtMinutes(m)}${entry.billable ? '' : ' (non-billable)'}${entry.note ? ' · ' + entry.note : ''}`);
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
}

export async function removeTimeEntry(ticketId, entryId) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t || !t.timeEntries) return;
  const idx = t.timeEntries.findIndex(e => e.id === entryId);
  if (idx < 0) return;
  const entry = t.timeEntries[idx];
  if (SESSION?.name && entry.agent !== SESSION.name && !window.isAdmin()) {
    alert('Only the agent who logged this entry (or an admin) can remove it.');
    return;
  }
  if (t._uuid) {
    try { await apiDelete(`/api/v1/tickets/${t._uuid}/time/${encodeURIComponent(entryId)}`); }
    catch (err) { alert(`Couldn't remove entry: ${err?.message || err}`); return; }
  }
  t.timeEntries.splice(idx, 1);
  logTicketEvent(ticketId, 'system', `Removed time entry · ${window.fmtMinutes(entry.minutes)}`);
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
}

export function showLogTimeModal(ticketId) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t) return;
  showModal(`Log time on ${window.escHtml(t.id)}`, `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:12px;line-height:1.5">Logged time rolls up in the ticket sidebar, the agent's totals, and the Reports page.</div>
    <div class="form-row"><label class="form-label">Quick presets</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${[5, 15, 30, 60, 120].map(m => `<button type="button" class="btn btn-sm" style="flex:1" data-action="tt.preset" data-min="${m}">${window.fmtMinutes(m)}</button>`).join('')}
      </div>
    </div>
    <div class="form-row"><label class="form-label">Minutes</label>
      <input class="form-input" type="number" id="te-min" min="1" max="1440" value="15"/>
    </div>
    <div class="form-row"><label class="form-label">Note (optional)</label>
      <input class="form-input" id="te-note" placeholder="e.g. Investigated payment gateway logs"/>
    </div>
    <div class="form-row" style="display:flex;align-items:center;gap:8px">
      <label class="toggle"><input type="checkbox" id="te-billable" checked><span class="toggle-slider"></span></label>
      <label class="form-label" style="margin:0">Billable</label>
    </div>
  `, () => {
    const min = document.getElementById('te-min').value;
    const note = document.getElementById('te-note').value;
    const billable = document.getElementById('te-billable').checked;
    addTimeEntry(ticketId, min, note, billable);
    closeModal();
  }, 'Log time');
}

registerActions({
  'tt.preset': (ds) => { const el = document.getElementById('te-min'); if (el) el.value = ds.min; },
});
