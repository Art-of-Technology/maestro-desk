// ─── Profile page ────────────────────────────────────────────────────────────
// The signed-in agent's own profile page (sidebar avatar → My profile or
// the profile-menu dropdown). Read-only summary of the agent's account
// (name / role / email / member-since) plus a snapshot of their workload:
// open + resolved + CSAT + recent activity, with quick links into Tickets,
// Settings tabs, and Sign out.
//
// Not to be confused with `js/profile-menu/` — that's the top-bar avatar
// dropdown. This module is the page rendered when you nav to "profile".
//
// Click handlers route through core/event-delegation.js as `data-action`.
// The inline `onmouseover`/`onmouseout` hover effects stay as-is —
// they're pure `this.style.X = Y` mutations with no module/bridge
// dependency, so the migration doesn't need to touch them. Long-term
// these should become CSS `:hover` rules across the codebase, but that's
// an unrelated cleanup.
//
// External reaches (interim, via window): escAttr, escHtml, logout — all
// still in app.js. Cross-module function calls (showAgentOOOModal,
// isAgentOOO, …) are direct ES imports.
//
// SESSION, TICKETS, AGENTS come from data.js / state.js (global lex env);
// SETTINGS_TAB is assigned inside the registered actions (also state.js).

import { registerActions } from '../core/event-delegation.js';
import { navTo } from '../core/keybindings.js';
import { openTicket } from '../tickets/detail.js';
import { showAgentOOOModal, isAgentOOO } from '../tickets/assignment-rules.js';
import { setTicketView } from '../tickets/list.js';

export function renderProfile() {
  if (!SESSION) return '';
  const myTickets = TICKETS.filter(t => t.agent === SESSION.name);
  const open      = myTickets.filter(t => t.status === 'open' || t.status === 'escalated');
  const resolved  = myTickets.filter(t => t.status === 'resolved');
  const csatRated = myTickets.filter(t => t.csat);
  const avgCSAT   = csatRated.length ? csatRated.reduce((a, t) => a + t.csat, 0) / csatRated.length : 0;

  // Synthesised account fields (SESSION only carries role/name/initials in the demo)
  const email = SESSION.email || (SESSION.name.toLowerCase().replace(/\s+/g, '.') + '@maestrodesk.com');
  const since = SESSION.since || '2024-09-01';

  // Recent activity = last few messages this agent posted
  const myMessages = [];
  TICKETS.forEach(t => (t.msgs || []).forEach(m => {
    if (m.from === SESSION.name) myMessages.push({ ticketId: t.id, subject: t.subject, msg: m });
  }));
  const recent = myMessages.slice(-8).reverse();

  const openRows = open.slice(0, 5).map(t => `
    <div data-action="profile.openTicket" data-ticket-id="${window.escAttr(t.id)}" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
      <span class="tag tag-${t.status}" style="font-size:9px">${t.status}</span>
      <span class="tag tag-${t.priority}" style="font-size:9px">${t.priority}</span>
      <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);flex-shrink:0">${t.id}</span>
      <span style="flex:1;font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.subject}</span>
      <span class="sla-${t.sla}" style="font-size:10px;text-transform:uppercase;font-weight:500;flex-shrink:0">${t.sla}</span>
    </div>`).join('');

  const recentRows = recent.slice(0, 6).map(r => `
    <div data-action="profile.openTicket" data-ticket-id="${window.escAttr(r.ticketId)}" style="padding:8px 4px;border-bottom:1px solid var(--rule);cursor:pointer;font-size:12px;transition:background .1s" onmouseover="this.style.background='var(--off2)'" onmouseout="this.style.background='transparent'">
      <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:3px">
        <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${r.ticketId}</span>
        ${r.msg.r === 'note'
          ? '<span class="note-mark">Note</span>'
          : '<span style="font-size:9px;color:var(--purple);text-transform:uppercase;letter-spacing:.06em;font-weight:600">Reply</span>'}
        <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink4);margin-left:auto">${r.msg.ts}</span>
      </div>
      <div style="color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.msg.t}</div>
    </div>`).join('');

  return `
    <div class="page">
      <div class="topbar"><div class="tb-title">My profile</div></div>
      <div class="page-scroll">
        <div class="card" style="display:flex;gap:18px;align-items:center;padding:24px">
          <div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;font-size:22px;flex-shrink:0">${SESSION.initials}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:22px;font-weight:700;color:var(--ink);letter-spacing:-.02em;line-height:1.1">${SESSION.name}</div>
            <div style="font-size:13px;color:var(--ink2);margin-top:8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
              <span class="tag tag-resolved">${SESSION.role}</span>
              <span style="font-family:'DM Mono',monospace;color:var(--ink3)">${email}</span>
            </div>
            <div style="font-size:11px;color:var(--ink3);margin-top:6px">Member since ${since}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn btn-sm" data-action="profile.editOOO">${isAgentOOO(SESSION.name) ? 'Edit OOO' : 'Set OOO'}</button>
            <button class="btn btn-sm" data-action="profile.gotoSettings" data-tab="profile">Edit profile</button>
          </div>
        </div>
        ${isAgentOOO(SESSION.name) ? (() => {
          const me = AGENTS.find(a => a.name === SESSION.name);
          // If a note is present, the dates go on the right; with no note,
          // the dates are the only content so we don't double-render them.
          const dates = `${window.escHtml(me?.oooFrom || '')}${me?.oooTo ? ' → ' + window.escHtml(me.oooTo) : ''}`;
          return `<div style="margin-top:12px;padding:12px 16px;background:var(--amber-lt);border:1px solid var(--amber);border-radius:var(--r);font-size:12px;color:var(--amber);display:flex;gap:10px;align-items:center">
            <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:11px">Out of office</span>
            ${me?.oooNote ? `<span style="color:var(--ink2);font-style:italic">${window.escHtml(me.oooNote)}</span>` : ''}
            <span style="margin-left:auto;font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${dates}</span>
          </div>`;
        })() : ''}

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px">
          <div class="r-tile" style="border-color:rgba(34,211,238,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${open.length}</div><div class="r-tile-l" style="color:var(--cyan)">Open</div></div>
          <div class="r-tile" style="border-color:rgba(52,211,153,0.3);background:var(--green-lt)"><div class="r-tile-n" style="color:var(--green)">${resolved.length}</div><div class="r-tile-l" style="color:var(--green)">Resolved</div></div>
          <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${csatRated.length?avgCSAT.toFixed(1):'—'}</div><div class="r-tile-l" style="color:var(--amber)">Avg CSAT (${csatRated.length})</div></div>
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink)">${myTickets.length}</div><div class="r-tile-l" style="color:var(--ink3)">Total assigned</div></div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">
          <div class="card">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div class="card-title" style="margin:0">Open tickets</div>
              ${open.length ? `<span class="link" data-action="profile.gotoMyTickets" style="font-size:11px">All →</span>` : ''}
            </div>
            ${open.length ? openRows : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No open tickets — nice work.</div>'}
          </div>
          <div class="card">
            <div class="card-title">Recent activity</div>
            ${recent.length ? recentRows : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No recent activity.</div>'}
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <div class="card-title">Account</div>
          <div class="ts-row"><span class="ts-key">Display name</span><span class="ts-val">${SESSION.name}</span></div>
          <div class="ts-row"><span class="ts-key">Initials</span><span class="ts-val">${SESSION.initials}</span></div>
          <div class="ts-row"><span class="ts-key">Role</span><span class="ts-val">${SESSION.role}</span></div>
          <div class="ts-row"><span class="ts-key">Email</span><span class="ts-val">${email}</span></div>
          <div class="ts-row"><span class="ts-key">Member since</span><span class="ts-val">${since}</span></div>
          <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
            <button class="btn" data-action="profile.gotoSettings" data-tab="profile">Edit profile</button>
            <button class="btn" data-action="profile.gotoSettings" data-tab="appearance">Appearance</button>
            <button class="btn" data-action="profile.gotoSettings" data-tab="notifications">Notifications</button>
            <button class="btn btn-danger" style="margin-left:auto" data-action="profile.logout">Sign out</button>
          </div>
        </div>
      </div>
    </div>`;
}

registerActions({
  'profile.openTicket':     (ds) => openTicket(ds.ticketId),
  'profile.editOOO':        () => showAgentOOOModal(SESSION.name),
  'profile.gotoSettings':   (ds) => { SETTINGS_TAB = ds.tab; navTo('settings'); },
  'profile.gotoMyTickets':  () => { setTicketView('mine'); navTo('tickets'); },
  'profile.logout':         () => window.logout(),
});
