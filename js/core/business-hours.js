// ─── Business Hours config page ──────────────────────────────────────────────
// The BUSINESS_HOURS config object itself (and the SLA-pause math that
// consumes it) lives in tickets/sla.js — this module owns only the Config →
// Business Hours page: the toggles/time inputs/holidays UI that mutates it.
//
// Each mutation invalidates the SLA clock and refreshes every ticket's SLA
// so the change is visible immediately on the tickets list.
//
// Click/change handlers route through core/event-delegation.js. No
// inline `on*=` references remain. `renderBusinessHours` is the only
// export consumed externally (app.js's router).
//
// External reaches (interim, via window): isAdmin, escHtml, escAttr —
// all still in app.js.

import { renderPage } from './router.js';
import {
  BUSINESS_HOURS,
  bhParseHM, invalidateSLAClock, refreshAllSLA, isWithinBusinessHours,
} from '../tickets/sla.js';
import { registerActions, registerChangeActions } from './event-delegation.js';

function bhSetEnabled(v) {
  BUSINESS_HOURS.enabled = !!v;
  invalidateSLAClock();
  refreshAllSLA();
  renderPage('business-hours');
}

function bhSetDayEnabled(idx, v) {
  const d = BUSINESS_HOURS.days[idx];
  if (!d) return;
  d.enabled = !!v;
  invalidateSLAClock();
  refreshAllSLA();
  renderPage('business-hours');
}

function bhSetDayTime(idx, field, v) {
  const d = BUSINESS_HOURS.days[idx];
  if (!d) return;
  if (!bhParseHM(v)) return;
  d[field] = v;
  invalidateSLAClock();
  refreshAllSLA();
}

function bhAddHoliday() {
  const el = document.getElementById('bh-new-holiday');
  if (!el) return;
  const v = el.value;
  if (!v) return;
  if (!BUSINESS_HOURS.holidays.includes(v)) BUSINESS_HOURS.holidays.push(v);
  BUSINESS_HOURS.holidays.sort();
  invalidateSLAClock();
  refreshAllSLA();
  renderPage('business-hours');
}

function bhRemoveHoliday(date) {
  const i = BUSINESS_HOURS.holidays.indexOf(date);
  if (i < 0) return;
  BUSINESS_HOURS.holidays.splice(i, 1);
  invalidateSLAClock();
  refreshAllSLA();
  renderPage('business-hours');
}

export function renderBusinessHours() {
  const admin = window.isAdmin();
  const now = new Date();
  const inHours = isWithinBusinessHours(now);
  const dayRows = BUSINESS_HOURS.days.map((d, i) => `
    <tr>
      <td style="width:80px;font-weight:500;color:var(--ink)">${window.escHtml(d.label)}</td>
      <td style="width:60px;text-align:center">
        <label class="toggle">
          <input type="checkbox" ${d.enabled ? 'checked' : ''} ${admin ? '' : 'disabled'} data-change-action="bh.setDayEnabled" data-day-idx="${i}">
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td>
        <input type="time" class="form-input" value="${window.escAttr(d.start)}" style="max-width:120px" ${admin && d.enabled ? '' : 'disabled'} data-change-action="bh.setDayTime" data-day-idx="${i}" data-field="start"/>
      </td>
      <td>
        <input type="time" class="form-input" value="${window.escAttr(d.end)}" style="max-width:120px" ${admin && d.enabled ? '' : 'disabled'} data-change-action="bh.setDayTime" data-day-idx="${i}" data-field="end"/>
      </td>
      <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${d.enabled ? window.escHtml(`${d.start}–${d.end}`) : '<span style="font-style:italic">closed</span>'}</td>
    </tr>`).join('');

  const holidayRows = BUSINESS_HOURS.holidays.map(date => `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--rule);border-radius:var(--r);margin-bottom:4px;background:var(--off2)">
      <span style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink2)">${window.escHtml(date)}</span>
      <span style="font-size:11px;color:var(--ink3);font-style:italic">${window.escHtml(new Date(date).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'short' }))}</span>
      ${admin ? `<button class="btn btn-sm" style="margin-left:auto" data-action="bh.removeHoliday" data-date="${window.escAttr(date)}">Remove</button>` : ''}
    </div>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Business Hours</div>
        <span style="font-size:11px;color:${inHours ? 'var(--green)' : 'var(--ink3)'};font-weight:500">${inHours ? '● Currently in business hours' : '○ Currently outside business hours'}</span>
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n c-${BUSINESS_HOURS.enabled ? 'green' : 'red'}" style="font-size:18px;line-height:1.1">${BUSINESS_HOURS.enabled ? 'On' : 'Off'}</div><div class="kpi-l">SLA pause</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${BUSINESS_HOURS.days.filter(d => d.enabled).length}</div><div class="kpi-l">Working days</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${BUSINESS_HOURS.holidays.length}</div><div class="kpi-l">Holidays</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">SLA pause outside business hours</span>
        <label class="toggle" style="margin-left:8px">
          <input type="checkbox" ${BUSINESS_HOURS.enabled ? 'checked' : ''} ${admin ? '' : 'disabled'} data-change-action="bh.setEnabled">
          <span class="toggle-slider"></span>
        </label>
        <span style="font-size:11px;color:var(--ink3);margin-left:auto;font-style:italic">${admin ? 'Changes apply to live SLA evaluation immediately.' : 'Read-only — admin access required to edit'}</span>
      </div>
      <div class="page-scroll">
        <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:14px">
          <div class="card">
            <div class="card-title">Weekly schedule</div>
            <table class="tbl" style="margin-top:8px">
              <thead><tr><th>Day</th><th style="text-align:center">Open</th><th>Start</th><th>End</th><th>Window</th></tr></thead>
              <tbody>${dayRows}</tbody>
            </table>
            <div style="margin-top:10px;font-size:11px;color:var(--ink3);line-height:1.5">When SLA pause is on, only minutes inside an open window count against a ticket's SLA timer. First-response thresholds count business minutes too once the customer's first message lands.</div>
          </div>
          <div class="card">
            <div class="card-title">Holidays (${BUSINESS_HOURS.holidays.length})</div>
            <div style="font-size:11px;color:var(--ink3);margin-bottom:10px;line-height:1.5">Dates listed here count as fully closed regardless of weekday schedule.</div>
            ${holidayRows || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:14px 0">No holidays added</div>'}
            ${admin ? `
              <div style="display:flex;gap:6px;margin-top:10px">
                <input type="date" class="form-input" id="bh-new-holiday" style="flex:1"/>
                <button class="btn btn-sm" data-action="bh.addHoliday">+ Add</button>
              </div>` : ''}
          </div>
        </div>
      </div>
    </div>`;
}

registerActions({
  'bh.addHoliday':    () => bhAddHoliday(),
  'bh.removeHoliday': (ds) => bhRemoveHoliday(ds.date),
});

registerChangeActions({
  'bh.setEnabled':    (ds, el) => bhSetEnabled(el.checked),
  'bh.setDayEnabled': (ds, el) => bhSetDayEnabled(parseInt(ds.dayIdx, 10), el.checked),
  'bh.setDayTime':    (ds, el) => bhSetDayTime(parseInt(ds.dayIdx, 10), ds.field, el.value),
});
