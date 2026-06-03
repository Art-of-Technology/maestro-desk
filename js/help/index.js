// ─── Help & Support ──────────────────────────────────────────────────────────
// Help page with four cards: Quick start (links into the most common
// flows), Keyboard shortcuts, FAQ (accordion), and Contact support
// (mock form — no network send).
//
// Click handlers are routed via core/event-delegation.js using
// `data-action="help.*"` — no inline onclick, no window bridge entry.
// `renderHelp` is called by the router in app.js as a direct ES import.

import { SESSION } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { registerActions } from '../core/event-delegation.js';
import { navTo, focusGlobalSearch } from '../core/keybindings.js';
import { setSettingsTab } from '../settings/index.js';

const HELP_FAQ_OPEN = new Set();

export function renderHelp() {
  return `
    <div class="page">
      <div class="topbar"><div class="tb-title">Help & Support</div></div>
      <div class="page-scroll">
        <div class="help-grid">
          ${helpQuickStart()}
          ${helpShortcuts()}
        </div>
        ${helpFAQ()}
        ${helpContact()}
      </div>
    </div>`;
}

function helpQuickStart() {
  const items = [
    {t:'Manage tickets',     d:'Triage, reply, escalate or resolve customer requests',                    a:'help.gotoTickets'},
    {t:'AI-assisted replies',d:'Add your Claude API key in Settings → AI to enable AI Draft',             a:'help.gotoSettingsAi'},
    {t:'Roles & permissions',d:'Define custom roles, assign agents, control access per area',             a:'help.gotoRoles'},
    {t:'Global search',      d:"Press / from anywhere to search tickets, customers, agents, and pages",   a:'help.focusSearch'},
  ];
  return `
    <div class="card">
      <div class="card-title">Quick start</div>
      <div class="help-quickstart">
        ${items.map(i => `<div class="help-card" data-action="${i.a}"><div class="help-card-t">${i.t}</div><div class="help-card-d">${i.d}</div></div>`).join('')}
      </div>
    </div>`;
}

function helpShortcuts() {
  const shortcuts = [
    {k:'/',     d:'Focus the global search bar'},
    {k:'↑ / ↓', d:'Navigate search results'},
    {k:'Enter', d:'Open the highlighted result'},
    {k:'Esc',   d:'Close the search dropdown'},
  ];
  return `
    <div class="card">
      <div class="card-title">Keyboard shortcuts</div>
      <table class="tbl" style="margin-top:6px">
        <tbody>${shortcuts.map(s => `<tr><td style="width:90px"><span class="help-kbd">${s.k}</span></td><td>${s.d}</td></tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function helpFAQ() {
  const faqs = [
    {q:'How do I add a new agent?',                       a:'Go to <strong>Roles & Permissions</strong>, click into a role, then use the <strong>+ Agent</strong> button. Admin access is required.'},
    {q:'Why does AI Draft show "no key configured"?',     a:'AI Draft uses the Claude API. Add your key in <strong>Settings → AI Assistant</strong>. The key is stored only in your browser localStorage and never sent to our servers.'},
    {q:'Can I create a custom permission?',                a:'Yes — <strong>Roles & Permissions → + Permission</strong>. The new permission is added as a column on every existing role with default off, ready for you to grant per-role.'},
    {q:'How are notifications generated?',                 a:'They are derived from current ticket state in real time: SLA breach, escalations, GDPR requests, and SLA warnings. Toggle which types appear in <strong>Settings → Notifications</strong>.'},
    {q:'Does my data sync across devices?',                a:'No — this demo stores state in your browser. Theme, notification preferences, and AI key persist via localStorage. Tickets, customers, and roles reset on reload.'},
    {q:'How do I delete a role?',                          a:'<strong>Roles & Permissions →</strong> click <strong>Delete</strong> next to the role. All agents must be reassigned off the role first. The Admin role is protected and cannot be deleted.'},
    {q:'Can a Read Only agent edit anything?',             a:'No — Read Only agents see all read-only views (matrix, settings, etc.) but the toggles, edit buttons, and delete actions are hidden or disabled.'},
  ];
  return `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Frequently asked questions</div>
      <div style="margin-top:6px">
        ${faqs.map((f,i) => `
          <div class="help-faq-item">
            <div class="help-faq-q" data-action="help.toggleFAQ" data-faq-idx="${i}">
              <span>${f.q}</span>
              <span class="help-faq-chev">${HELP_FAQ_OPEN.has(i)?'−':'+'}</span>
            </div>
            ${HELP_FAQ_OPEN.has(i)?`<div class="help-faq-a">${f.a}</div>`:''}
          </div>`).join('')}
      </div>
    </div>`;
}

function toggleFAQ(i) {
  if (HELP_FAQ_OPEN.has(i)) HELP_FAQ_OPEN.delete(i); else HELP_FAQ_OPEN.add(i);
  renderPage('help');
}

function helpContact() {
  return `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Contact support</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Can't find what you need? Send us a message and we'll get back to you within one business day.</div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Your name</label><input class="form-input" id="sup-name" value="${SESSION?.name||''}"/></div>
        <div class="form-row"><label class="form-label">Reply-to email</label><input class="form-input" id="sup-email" type="email" placeholder="you@company.com"/></div>
      </div>
      <div class="form-row"><label class="form-label">Subject</label>
        <select class="form-input" id="sup-subj">
          <option>Question about a feature</option>
          <option>Bug report</option>
          <option>Account issue</option>
          <option>Billing</option>
          <option>Other</option>
        </select>
      </div>
      <div class="form-row"><label class="form-label">Message</label><textarea class="form-input" id="sup-msg" placeholder="Describe what you need help with…" style="min-height:100px"></textarea></div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-solid" data-action="help.submitSupport">Send message</button>
        <span id="sup-confirm" style="font-size:11px;color:var(--green);font-family:'DM Mono',monospace;display:none">Message sent — we'll be in touch.</span>
      </div>
    </div>`;
}

function submitSupport() {
  const name = document.getElementById('sup-name')?.value.trim();
  const msg  = document.getElementById('sup-msg')?.value.trim();
  if (!name || !msg) return;
  const box = document.getElementById('sup-msg'); if (box) box.value = '';
  const c = document.getElementById('sup-confirm'); if (c) c.style.display = 'inline';
  setTimeout(() => { const el = document.getElementById('sup-confirm'); if (el) el.style.display = 'none'; }, 4000);
}

registerActions({
  'help.gotoTickets':     () => navTo('tickets'),
  'help.gotoSettingsAi':  () => { navTo('settings'); setSettingsTab('ai'); },
  'help.gotoRoles':       () => navTo('roles'),
  'help.focusSearch':     () => focusGlobalSearch(),
  'help.toggleFAQ':       (ds) => toggleFAQ(parseInt(ds.faqIdx, 10)),
  'help.submitSupport':   () => submitSupport(),
});
