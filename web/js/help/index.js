// ─── Help & Support ──────────────────────────────────────────────────────────
// Help page with four cards: Quick start (links into the most common
// flows), Keyboard shortcuts, FAQ (accordion), and Contact support
// (mock form — no network send).
//
// Click handlers are routed via core/event-delegation.js using
// `data-action="help.*"` — no inline onclick, no window bridge entry.
// `renderHelp` is called by the router in app.js as a direct ES import.

import { SESSION } from '../core/state.js';
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
    {t:'AI-assisted replies',d:'Check your workspace AI connection, model and credit in Settings',        a:'help.gotoSettingsAi'},
    {t:'Roles & permissions',d:'Review roles and the capabilities managed by your workspace admin',       a:'help.gotoRoles'},
    {t:'Global search',      d:"Press / from anywhere to search tickets, customers, agents, and pages",   a:'help.focusSearch'},
    {t:'Guided tours',       d:'Learn to review, reply, use placeholders and handle your first ticket',    a:'guides.open'},
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
    {q:'Where should a new agent start?', a:'Select <strong>Guides</strong> in the top bar, or <strong>Guided tours</strong> above. The tour covers reviewing tickets, customer replies, AI suggestions, placeholders, statuses and handovers. Ask your lead which queue to work and which escalation procedures to follow.'},
    {q:'What should I check before replying?', a:'Read the latest customer message, earlier replies and internal notes. Open <strong>Details</strong> to check the customer, brand, assigned agent, priority and status. Verify account facts and policy claims against current guidance. Check AI suggestions and their <strong>References</strong> before sending.'},
    {q:'What is the difference between Reply and Internal note?', a:'<strong>Reply</strong> sends a customer-facing message. <strong>Internal note</strong> is for colleagues; type <strong>@</strong> and select an agent to mention them, then choose <strong>Add note</strong>. Check the selected tab before submitting. A saved draft has not been sent.'},
    {q:'How do I use placeholders in a response?', a:'In the Reply composer, choose <strong>Macros</strong>, then a canned response. In <strong>Preview response</strong>, check the automatically filled {name}, {ticket}, {brand} and {agent} values. Fill any missing fields, such as {transaction_reference}, with verified customer details. Choose <strong>Insert response</strong>, then review the whole draft. Inserting does not send it; replies with unfilled placeholders are blocked.'},
    {q:'How do I change a ticket’s status?', a:'Use <strong>Details → Properties → Ticket status</strong>. Use Open for active work, Pending while waiting, and Escalated when further help is needed. Add a note explaining the next action and owner. Use GDPR for privacy requests under your team’s process. The arrow beside <strong>Send</strong> also offers sending and resolving, setting pending or escalating.'},
    {q:'Should I resolve or close a ticket?', a:'Choose <strong>Resolve</strong> when the issue is answered or completed. Use <strong>More → Close without resolution</strong> for spam, abuse, duplicates or another closure reason; select the required reason. Closing this way sends no customer email or satisfaction survey. Choose <strong>Reopen</strong> if more work is needed.'},
    {q:'How do I set a follow-up reminder?', a:'Use <strong>More → Snooze</strong> on an active ticket and choose when it should return. Leave an internal note explaining what to check next. Find it in the <strong>Snoozed</strong> view and use <strong>More → Wake up</strong> to bring it back early.'},
    {q:'What should I do if AI replies are unavailable?', a:'Open <strong>Settings → AI Assistant</strong> and choose <strong>Check connection</strong>. Respovia uses a shared server-side Claude connection; agents do not enter a personal API key here. The check verifies the server key and model access. Requests also need provider billing credit and workspace credit. Ask your administrator to investigate any configuration or credit error.'},
    {q:'Does my work sync across devices?', a:'In a connected workspace, saved tickets, customer records and roles are loaded from the server when you sign in. Ordinary unsent Reply and Internal note drafts are stored in the current browser, so do not assume they will appear on another device. Shared AI drafts are a separate feature. Demo data and some browser preferences behave differently.'},
    {q:'Why am I asked to sign in again after eight hours?', a:'Each session ends eight hours after login, even while you are working. Activity, refreshing the page and switching workspaces do not extend it. A warning appears 30 minutes before expiry while the app is visible and focused. If you return during the final 30 minutes, it shows the remaining time. At expiry, sign in again to continue.'},
    {q:'How do roles and permissions work?', a:'Workspace admins manage roles in <strong>Roles &amp; Permissions</strong>. The available capabilities include <strong>Manage custom fields</strong> and <strong>Delete &amp; merge</strong>; there is no custom permission grid. A role named Read Only does not itself prevent all editing. Ask your administrator which capabilities your role has.'},
    {q:'How do I get a new colleague access?', a:'Ask your workspace administrator to arrange the colleague’s account and workspace access. The <strong>+ Agent</strong> form under a role only adds a local entry; it does not create a sign-in account or send an invitation.'},
    {q:'How do I manage notifications?', a:'Open <strong>Settings → Notifications</strong> to choose which alert types appear in the bell and review mention email preferences. Follow the linked ticket to check its current state before acting on an alert.'},
    {q:'How do I delete a role?', a:'In <strong>Roles &amp; Permissions</strong>, an admin can choose <strong>Delete</strong> beside a role after reassigning its agents. The Admin role is protected and cannot be deleted.'},
    {q:'How do I get help with a problem?', a:'Ask your lead or use your team’s agreed support channel. Include the affected ticket ID, the steps you took and the error message, without sharing passwords or API keys. The contact form below is a demo and does not send a support request.'},
  ];
  return `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Frequently asked questions</div>
      <div style="margin-top:6px">
        ${faqs.map((f,i) => `
          <div class="help-faq-item">
            <button type="button" class="help-faq-q" data-action="help.toggleFAQ" data-faq-idx="${i}" aria-expanded="${HELP_FAQ_OPEN.has(i)}" aria-controls="help-faq-answer-${i}">
              <span>${f.q}</span>
              <span class="help-faq-chev" aria-hidden="true">${HELP_FAQ_OPEN.has(i)?'−':'+'}</span>
            </button>
            <div class="help-faq-a" id="help-faq-answer-${i}" ${HELP_FAQ_OPEN.has(i)?'':'hidden'}>${f.a}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

function toggleFAQ(i, button) {
  if (HELP_FAQ_OPEN.has(i)) HELP_FAQ_OPEN.delete(i); else HELP_FAQ_OPEN.add(i);
  const open = HELP_FAQ_OPEN.has(i);
  button.setAttribute('aria-expanded', String(open));
  button.querySelector('.help-faq-chev').textContent = open ? '−' : '+';
  document.getElementById(button.getAttribute('aria-controls')).hidden = !open;
}

function helpContact() {
  return `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Contact support</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">This is a demo form. It does not send a support request. For help, contact your lead or use your team’s agreed support channel.</div>
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
        <button class="btn btn-solid" data-action="help.submitSupport">Try demo form</button>
        <span id="sup-confirm" style="font-size:11px;color:var(--green);font-family:'DM Mono',monospace;display:none">Demo complete. No message was sent.</span>
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
  'help.toggleFAQ':       (ds, el) => toggleFAQ(parseInt(ds.faqIdx, 10), el),
  'help.submitSupport':   () => submitSupport(),
});
