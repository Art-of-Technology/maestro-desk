// ─── Linked & merged tickets ─────────────────────────────────────────────────
// Two related but distinct ticket relationships:
//
//   • Linked  — bidirectional reference between two open tickets. Lets an
//               agent see related context without changing either ticket's
//               state. Stored as t.linked[] on both sides.
//
//   • Merged  — declares one ticket a duplicate of another. The source's
//               messages copy across to the primary (tagged with mergedFrom
//               so unmerge can strip them), the source goes to 'resolved',
//               and a webhook fires. Reversible via unmergeTicket().
//
// External reaches (interim, via window): escAttr, escHtml, showModal,
// closeModal, logTicketEvent, openTicket, renderPage, updateNavBadges,
// fireWebhook, ticketPayload — all still in app.js. refreshTicketSLA
// is a direct ES import.

import { refreshTicketSLA } from './sla.js';

export function linkTickets(id, otherId) {
  const t = TICKETS.find(x => x.id === id);
  const other = TICKETS.find(x => x.id === otherId);
  if (!t || !other || id === otherId) return;
  if (!t.linked) t.linked = [];
  if (!other.linked) other.linked = [];
  if (!t.linked.includes(otherId)) {
    t.linked.push(otherId);
    other.linked.push(id);
    window.logTicketEvent(id, 'system', `Linked to ${otherId}`);
    window.logTicketEvent(otherId, 'system', `Linked to ${id}`);
  }
  if (CURRENT_TICKET === id) window.openTicket(id);
}

export function unlinkTicket(id, otherId) {
  const t = TICKETS.find(x => x.id === id);
  const other = TICKETS.find(x => x.id === otherId);
  if (!t || !other) return;
  if (t.linked) t.linked = t.linked.filter(x => x !== otherId);
  if (other.linked) other.linked = other.linked.filter(x => x !== id);
  window.logTicketEvent(id, 'system', `Unlinked from ${otherId}`);
  window.logTicketEvent(otherId, 'system', `Unlinked from ${id}`);
  if (CURRENT_TICKET === id) window.openTicket(id);
}

export function showMergeTicketModal(id) {
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;
  if (t.mergedInto) { alert(`Already merged into ${t.mergedInto}.`); return; }
  const card = x => `
      <div onmousedown="closeModal();mergeTickets('${window.escAttr(id)}','${window.escAttr(x.id)}')" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
        <span class="tag tag-${window.escAttr(x.status)}" style="font-size:9px">${window.escHtml(x.status)}</span>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${window.escHtml(x.id)}</span>
        <span style="flex:1;font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(x.subject)}</span>
      </div>`;
  const sameCust = TICKETS.filter(x => x.id !== id && !x.mergedInto && x.customerId === t.customerId);
  const others   = TICKETS.filter(x => x.id !== id && !x.mergedInto && x.customerId !== t.customerId);
  window.showModal('Merge ticket into…', `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">${window.escHtml(t.id)} will be marked as a duplicate of the primary you choose. Its messages copy across, the audit trail is preserved on both sides, and ${window.escHtml(t.id)} is set to <strong style="color:var(--ink)">resolved</strong>.</div>
    ${sameCust.length ? `<div style="font-size:11px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Same customer (most likely duplicate)</div>${sameCust.map(card).join('')}` : ''}
    ${others.length ? `<div style="font-size:11px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px">Other tickets</div><div style="max-height:240px;overflow-y:auto">${others.map(card).join('')}</div>` : ''}
    ${!sameCust.length && !others.length ? '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No primary candidates available</div>' : ''}
  `, null, null);
}

export function mergeTickets(srcId, primaryId) {
  if (srcId === primaryId) return;
  const src = TICKETS.find(x => x.id === srcId);
  const primary = TICKETS.find(x => x.id === primaryId);
  if (!src || !primary || src.mergedInto) return;
  // Chain-merge guard: don't merge into a ticket that's itself a duplicate.
  if (primary.mergedInto) {
    alert(`${primaryId} is already a duplicate of ${primary.mergedInto}. Pick the chain's primary instead.`);
    return;
  }
  src.mergedInto = primaryId;
  src.mergedAt = new Date().toISOString().slice(0, 10);
  primary.mergedFrom = primary.mergedFrom || [];
  if (!primary.mergedFrom.includes(srcId)) primary.mergedFrom.push(srcId);
  primary.msgs = primary.msgs || [];
  // Tag every msg pushed during this merge with `mergedFrom: srcId` so unmergeTicket
  // can strip them cleanly without leaving phantom messages on the primary.
  primary.msgs.push({
    from: 'System', r: 'system',
    t: `── Merged from ${srcId}: "${src.subject}" ──`,
    ts: new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }),
    mergedFrom: srcId,
  });
  (src.msgs || []).forEach(m => primary.msgs.push({ ...m, mergedFrom: srcId }));
  if (src.status !== 'resolved') {
    src._statusBeforeMerge = src.status;
    window.logTicketEvent(srcId, 'status', `Status: ${src.status} → resolved (merged)`);
    src.status = 'resolved';
    refreshTicketSLA(src);
  }
  window.logTicketEvent(srcId, 'system', `Merged into ${primaryId}`);
  window.logTicketEvent(primaryId, 'system', `Merged in ${srcId}: "${src.subject}"`);
  window.updateNavBadges();
  if (CURRENT_TICKET === srcId || CURRENT_TICKET === primaryId) window.openTicket(primaryId);
  else window.renderPage('tickets');
  window.fireWebhook('ticket.merged', { source: window.ticketPayload(src), primary: window.ticketPayload(primary) });
}

export function unmergeTicket(srcId) {
  const src = TICKETS.find(x => x.id === srcId);
  if (!src || !src.mergedInto) return;
  const primaryId = src.mergedInto;
  const primary = TICKETS.find(x => x.id === primaryId);
  if (primary) {
    if (primary.mergedFrom) primary.mergedFrom = primary.mergedFrom.filter(x => x !== srcId);
    if (primary.msgs) primary.msgs = primary.msgs.filter(m => m.mergedFrom !== srcId);
  }
  src.mergedInto = null;
  src.mergedAt = null;
  // Restore the pre-merge status if we captured one; otherwise default to 'open'
  // so the un-merged ticket re-enters the queue rather than staying resolved-but-active.
  const restored = src._statusBeforeMerge || 'open';
  if (src.status === 'resolved' && src.status !== restored) {
    window.logTicketEvent(srcId, 'status', `Status: resolved → ${restored} (un-merged)`);
    src.status = restored;
    refreshTicketSLA(src);
  }
  delete src._statusBeforeMerge;
  window.logTicketEvent(srcId, 'system', `Un-merged from ${primaryId}`);
  if (primary) window.logTicketEvent(primaryId, 'system', `${srcId} un-merged`);
  window.updateNavBadges();
  if (CURRENT_TICKET === srcId) window.openTicket(srcId);
  else if (CURRENT_TICKET === primaryId) window.openTicket(primaryId);
  else window.renderPage('tickets');
}

export function showLinkTicketModal(id) {
  const t = TICKETS.find(x => x.id === id); if (!t) return;
  const current = t.linked || [];
  const candidates = TICKETS.filter(x => x.id !== id && !current.includes(x.id));
  const list = candidates.length
    ? candidates.map(x => `
        <div onmousedown="closeModal();linkTickets('${id}','${window.escAttr(x.id)}')" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
          <span class="tag tag-${x.status}" style="font-size:9px">${x.status}</span>
          <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${x.id}</span>
          <span style="flex:1;font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${x.subject}</span>
        </div>`).join('')
    : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No tickets available to link</div>';
  window.showModal('Link a ticket', `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:12px;line-height:1.5">Linking creates a bidirectional reference between two tickets so an agent can see related context.</div>
    <div style="max-height:380px;overflow-y:auto">${list}</div>
  `, null, null);
}
