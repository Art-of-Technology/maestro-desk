// ─── CSAT (customer satisfaction) ────────────────────────────────────────────
// Two surfaces share this module:
//   1. The ticket sidebar's CSAT block — renders the survey response if rated,
//      a "sent · awaiting response" pill if requested but not rated, or a
//      "Send satisfaction survey" button if the ticket is resolved.
//   2. The CSAT Surveys config page — aggregate KPIs, score distribution,
//      awaiting-response list, and per-ticket response table with filters.
//
// Click/change handlers route through core/event-delegation.js. The CSAT
// survey modal's star-rating mouseover/mouseout handlers are bound
// programmatically after showModal renders (mouseover delegation is a
// can of worms not worth opening for one-off interactive UI; quick-switcher
// uses the same per-render-bind pattern for its hover).
//
// External reaches (interim, via window): escHtml, escAttr, showModal,
// closeModal, renderPage — all still in app.js. openTicket and navTo
// are direct ES imports.
//
// logTicketEvent is imported from core/activity-log.js; fireWebhook and
// ticketPayload from webhooks/index.js — those are already extracted.
//
// TICKETS, CUSTOMERS come from data.js via the global lexical env;
// CURRENT_TICKET, CURRENT_PAGE, CSAT_FILTER_AGENT, CSAT_FILTER_SCORE come
// from core/state.js the same way.

import { logTicketEvent } from '../core/activity-log.js';
import { fireWebhook, ticketPayload } from '../webhooks/index.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { navTo } from '../core/keybindings.js';
import { openTicket } from './detail.js';
import { apiPatch } from '../core/api-client.js';

function csatStarString(n) {
  const score = Math.max(0, Math.min(5, parseInt(n, 10) || 0));
  return '★'.repeat(score) + '☆'.repeat(5 - score);
}
function csatColorFor(n) {
  return n >= 4 ? 'var(--green)' : n === 3 ? 'var(--blue)' : 'var(--red)';
}

export function ticketCSATBlock(t) {
  if (t.csat) {
    const stars = csatStarString(t.csat);
    const color = csatColorFor(t.csat);
    return `
      <div class="ts-section">
        <div class="ts-heading">Survey response</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="color:${color};font-size:16px;letter-spacing:1px">${stars}</span>
          <span style="font-family:'DM Mono',monospace;font-size:11px;color:${color};font-weight:500">${t.csat}/5</span>
        </div>
        ${t.csatComment ? `<div style="font-size:11px;color:var(--ink2);font-style:italic;line-height:1.45;margin-bottom:6px">"${window.escHtml(t.csatComment)}"</div>` : ''}
        <div style="font-size:10px;color:var(--ink3);font-family:'DM Mono',monospace">Submitted ${window.escHtml(t.csatSubmittedAt || '—')}</div>
      </div>`;
  }
  if (t.csatRequestedAt) {
    const count = t.csatReminderCount || 0;
    const reminderNote = t.csatLastRemindedAt
      ? ` · reminder ${count} sent ${window.escHtml(t.csatLastRemindedAt)}`
      : '';
    return `
      <div class="ts-section">
        <div class="ts-heading">CSAT survey</div>
        <div style="font-size:11px;color:var(--ink2);margin-bottom:8px">Sent ${window.escHtml(t.csatRequestedAt)} · awaiting response${reminderNote}</div>
        <button class="btn btn-sm" data-action="csat.openSurvey" data-ticket-id="${window.escAttr(t.id)}">Preview customer view</button>
      </div>`;
  }
  if (t.status === 'resolved') {
    return `
      <div class="ts-section">
        <div class="ts-heading">CSAT survey</div>
        <button class="btn btn-sm" data-action="csat.request" data-ticket-id="${window.escAttr(t.id)}">Send satisfaction survey</button>
      </div>`;
  }
  return '';
}

async function requestCSAT(id) {
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;
  const stamp = new Date().toISOString().slice(0, 10);
  if (t._uuid) {
    try { await apiPatch(`/api/v1/tickets/${t._uuid}`, { csat_requested_at: stamp }); }
    catch (err) { alert(`Couldn't send survey: ${err?.message || err}`); return; }
  }
  t.csatRequestedAt = stamp;
  logTicketEvent(id, 'system', 'CSAT survey sent to customer');
  if (CURRENT_TICKET === id) openTicket(id);
  openCSATSurveyModal(id);
}

function openCSATSurveyModal(id) {
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;
  const cust = CUSTOMERS.find(c => c.id === t.customerId);
  const initial = t.csat || 0;
  const body = `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Customer view · how ${cust ? window.escHtml(cust.first) : 'the customer'} sees the survey for <strong style="color:var(--ink)">${window.escHtml(t.id)}</strong>.</div>
    <div style="text-align:center;padding:18px 0;border:1px solid var(--rule);border-radius:var(--r);background:var(--off2)">
      <div style="font-size:13px;color:var(--ink);margin-bottom:4px">How would you rate your support experience?</div>
      <div style="font-size:11px;color:var(--ink3);margin-bottom:14px">"${window.escHtml(t.subject)}"</div>
      <div id="csat-stars" style="font-size:32px;letter-spacing:6px;cursor:pointer;user-select:none;color:var(--rule);font-weight:300">
        ${[1,2,3,4,5].map(n => `<span data-score="${n}" data-action="csat.pick">★</span>`).join('')}
      </div>
      <div id="csat-label" style="font-size:11px;color:var(--ink3);margin-top:10px;height:14px;font-family:'DM Mono',monospace"></div>
    </div>
    <div style="margin-top:14px">
      <label class="form-label">Tell us more (optional)</label>
      <textarea class="form-input" id="csat-comment" rows="3" placeholder="What worked well? What could be better?">${window.escHtml(t.csatComment || '')}</textarea>
    </div>
    <input type="hidden" id="csat-pick" value="${initial}"/>`;
  // ticketId captured by closure rather than re-read from DOM, so the modal can't
  // submit against a different ticket if it's reused mid-flight.
  const ticketId = t.id;
  window.showModal('Customer satisfaction survey', body, () => {
    const score = parseInt(document.getElementById('csat-pick').value, 10);
    const comment = document.getElementById('csat-comment').value.trim();
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      alert('Please pick a rating from 1 to 5.');
      return;
    }
    submitCSAT(ticketId, score, comment);
  }, 'Submit rating');
  // Star-rating hover preview. mouseover/mouseout don't go through the
  // dispatcher (only one module in the codebase needs them, and only
  // inside this transient modal) — bind directly on each star span.
  document.querySelectorAll('#csat-stars span').forEach(el => {
    el.addEventListener('mouseover', () => csatHover(parseInt(el.dataset.score, 10)));
    el.addEventListener('mouseout',  () => csatHover(0));
  });
  if (initial) csatHover(initial);
}

function csatHover(n) {
  const stars = document.querySelectorAll('#csat-stars span');
  const picked = parseInt(document.getElementById('csat-pick')?.value || '0', 10);
  const show = n || picked;
  const labels = ['', 'Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied'];
  stars.forEach(s => {
    const score = parseInt(s.dataset.score, 10);
    s.style.color = score <= show ? 'var(--amber)' : 'var(--rule)';
  });
  const label = document.getElementById('csat-label');
  if (label) label.textContent = labels[show] || '';
}

function csatPick(n) {
  const input = document.getElementById('csat-pick');
  if (input) input.value = String(n);
  csatHover(n);
}

async function submitCSAT(id, score, comment) {
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;
  const clamped = Math.max(1, Math.min(5, parseInt(score, 10)));
  if (!Number.isInteger(clamped)) return;
  const submittedAt = new Date().toISOString().slice(0, 10);
  const requestedAt = t.csatRequestedAt || submittedAt;
  if (t._uuid) {
    try {
      await apiPatch(`/api/v1/tickets/${t._uuid}`, {
        csat_score:        clamped,
        csat_stars:        clamped,
        csat_comment:      comment || null,
        csat_submitted_at: submittedAt,
        csat_requested_at: requestedAt,
      });
    } catch (err) { alert(`Couldn't submit CSAT: ${err?.message || err}`); return; }
  }
  t.csat = clamped;
  t.csatStars = clamped;
  t.csatComment = comment || null;
  t.csatSubmittedAt = submittedAt;
  t.csatRequestedAt = requestedAt;
  logTicketEvent(id, 'system', `CSAT submitted: ${clamped}/5${comment ? ' with comment' : ''}`);
  fireWebhook('csat.submitted', { ...ticketPayload(t), csat: clamped, comment: comment || null });
  window.closeModal();
  if (CURRENT_TICKET === id) openTicket(id);
  if (CURRENT_PAGE === 'csat') window.renderPage('csat');
}

export function renderCSAT() {
  const rated = TICKETS.filter(t => t.csat);
  const requested = TICKETS.filter(t => t.csatRequestedAt && !t.csat);
  const total = rated.length;
  const avg = total ? rated.reduce((s, t) => s + t.csat, 0) / total : 0;
  const promoters = rated.filter(t => t.csat === 5).length;
  const detractors = rated.filter(t => t.csat <= 2).length;
  const responseRate = (total + requested.length) > 0
    ? Math.round((total / (total + requested.length)) * 100)
    : 0;

  const dist = [1,2,3,4,5].map(n => rated.filter(t => t.csat === n).length);
  const distMax = Math.max(...dist, 1);
  const distRows = [5,4,3,2,1].map(n => {
    const c = dist[n-1];
    const pct = (c / distMax) * 100;
    const color = n >= 4 ? 'var(--green)' : n === 3 ? 'var(--blue)' : 'var(--red)';
    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <div style="width:40px;font-family:'DM Mono',monospace;font-size:11px;color:var(--ink2)">${n} ★</div>
        <div style="flex:1;height:8px;background:var(--off2);border-radius:4px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${color}"></div></div>
        <div style="width:40px;text-align:right;font-family:'DM Mono',monospace;font-size:11px;color:var(--ink2)">${c}</div>
      </div>`;
  }).join('');

  const agentNames = [...new Set(rated.map(t => t.agent).filter(Boolean))].sort();
  let visible = [...rated].sort((a,b) => (b.csatSubmittedAt||'').localeCompare(a.csatSubmittedAt||''));
  if (CSAT_FILTER_SCORE !== 'all') visible = visible.filter(t => String(t.csat) === CSAT_FILTER_SCORE);
  if (CSAT_FILTER_AGENT !== 'all') visible = visible.filter(t => t.agent === CSAT_FILTER_AGENT);

  const rows = visible.map(t => {
    const cust = CUSTOMERS.find(c => c.id === t.customerId);
    const stars = csatStarString(t.csat);
    const color = csatColorFor(t.csat);
    return `
    <tr>
      <td class="bold">${window.escHtml(t.id)}</td>
      <td>${cust ? window.escHtml(cust.first + ' ' + cust.last) : '<span style="color:var(--ink3)">—</span>'}</td>
      <td style="color:var(--ink2)">${window.escHtml(t.subject)}</td>
      <td>${window.escHtml(t.agent || '')}</td>
      <td><span style="color:${color};letter-spacing:1px">${stars}</span> <span style="font-family:'DM Mono',monospace;font-size:11px;color:${color};font-weight:500">${t.csat}/5</span></td>
      <td style="color:var(--ink2);max-width:280px">${t.csatComment ? `<span style="font-style:italic">"${window.escHtml(t.csatComment)}"</span>` : '<span style="color:var(--ink3)">—</span>'}</td>
      <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${window.escHtml(t.csatSubmittedAt || '—')}</td>
      <td style="text-align:right;white-space:nowrap"><button class="btn btn-sm" data-action="csat.openTicket" data-ticket-id="${window.escAttr(t.id)}">Open</button></td>
    </tr>`;
  }).join('');

  const pendingRows = requested.map(t => {
    const cust = CUSTOMERS.find(c => c.id === t.customerId);
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--rule);border-radius:var(--r);margin-bottom:6px;background:var(--off2)">
        <div style="font-family:'DM Mono',monospace;font-size:12px;font-weight:500">${window.escHtml(t.id)}</div>
        <div style="flex:1;font-size:12px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(t.subject)}${cust ? ' · ' + window.escHtml(cust.first + ' ' + cust.last) : ''}</div>
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">sent ${window.escHtml(t.csatRequestedAt)}</div>
        <button class="btn btn-sm" data-action="csat.openSurvey" data-ticket-id="${window.escAttr(t.id)}">Open survey</button>
      </div>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">CSAT Surveys</div>
        <span style="font-size:11px;color:var(--ink3);font-style:italic">Surveys auto-send when a ticket is marked resolved.</span>
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n c-amber">${total ? avg.toFixed(1) : '—'}</div><div class="kpi-l">Avg score</div></div>
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Responses</div></div>
        <div class="kpi"><div class="kpi-n c-green">${total ? Math.round((promoters/total)*100) : 0}%</div><div class="kpi-l">Promoters (5★)</div></div>
        <div class="kpi"><div class="kpi-n c-red">${total ? Math.round((detractors/total)*100) : 0}%</div><div class="kpi-l">Detractors (1–2★)</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${responseRate}%</div><div class="kpi-l">Response rate</div></div>
      </div>
      <div class="page-scroll">
        <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:14px;margin-bottom:14px">
          <div class="card">
            <div class="card-title">Score distribution</div>
            ${total ? distRows : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:20px 0">No CSAT ratings yet</div>'}
          </div>
          <div class="card">
            <div class="card-title">Awaiting response (${requested.length})</div>
            ${requested.length ? pendingRows : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:20px 0">No surveys are pending. Resolve a ticket to send one.</div>'}
          </div>
        </div>
        <div class="filter-bar">
          <span class="filter-label">Score</span>
          <select class="filter-select" data-change-action="csat.setFilterScore">
            <option value="all" ${CSAT_FILTER_SCORE==='all'?'selected':''}>All</option>
            ${[5,4,3,2,1].map(n => `<option value="${n}" ${CSAT_FILTER_SCORE===String(n)?'selected':''}>${n} ★</option>`).join('')}
          </select>
          <span class="filter-label" style="margin-left:8px">Agent</span>
          <select class="filter-select" data-change-action="csat.setFilterAgent">
            <option value="all" ${CSAT_FILTER_AGENT==='all'?'selected':''}>All</option>
            ${agentNames.map(a => `<option value="${window.escAttr(a)}" ${CSAT_FILTER_AGENT===a?'selected':''}>${window.escHtml(a)}</option>`).join('')}
          </select>
          <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${visible.length} of ${total}</span>
        </div>
        <table class="tbl">
          <thead><tr>
            <th>Ticket</th><th>Customer</th><th>Subject</th><th>Agent</th><th>Score</th><th>Comment</th><th>Submitted</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${visible.length === 0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No responses match</div><div class="empty-line"></div></div>` : ''}
      </div>
    </div>`;
}

registerActions({
  'csat.openSurvey': (ds) => openCSATSurveyModal(ds.ticketId),
  'csat.request':    (ds) => requestCSAT(ds.ticketId),
  'csat.pick':       (ds) => csatPick(parseInt(ds.score, 10)),
  'csat.openTicket': (ds) => { openTicket(ds.ticketId); navTo('tickets'); },
});

registerChangeActions({
  'csat.setFilterScore': (ds, el) => { CSAT_FILTER_SCORE = el.value; window.renderPage('csat'); },
  'csat.setFilterAgent': (ds, el) => { CSAT_FILTER_AGENT = el.value; window.renderPage('csat'); },
});
