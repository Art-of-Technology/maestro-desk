// ─── Sidebar collapse ────────────────────────────────────────────────────────
// Toggles the left nav between the full 200px column and a 60px icon rail
// (issue #447). All the layout lives in shell.css under `.sidebar.collapsed`;
// this module only owns the class and its persistence.
//
// Per-browser, like the collapsible section state in core/collapsible.js —
// it's a viewport preference, not workspace data, so it never goes to the
// API. Applied at module load so the rail is in place before the first
// paint rather than flashing wide-then-narrow.

import { registerActions } from './event-delegation.js';

const KEY = 'sidebar_collapsed';

function read() {
  try { return localStorage.getItem(KEY) === '1'; }
  catch { return false; }   // private mode / storage disabled
}

function persist(collapsed) {
  // Quota or privacy-mode failures must never break the toggle itself —
  // same guard core/widget-shell.js uses around its layout writes.
  try { localStorage.setItem(KEY, collapsed ? '1' : '0'); }
  catch { /* preference simply won't survive the reload */ }
}

// Paint the current state. Called at load and after every toggle; the button
// label/aria flips with it so a screen reader and a sighted user agree.
function apply(collapsed) {
  const bar = document.querySelector('.sidebar');
  if (bar) bar.classList.toggle('collapsed', collapsed);
  const btn = document.getElementById('sb-collapse');
  if (btn) {
    btn.textContent = collapsed ? '›' : '‹';
    const label = collapsed ? 'Expand menu' : 'Collapse menu';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
  // Collapsed, the sign-out row is an unlabelled dot — give it a tooltip so
  // it isn't a mystery click target.
  const foot = document.querySelector('.sidebar .sb-foot');
  if (foot) {
    if (collapsed) foot.setAttribute('title', 'Sign out');
    else foot.removeAttribute('title');
  }
  // Same problem, eight more times: the rail hides every .sb-lbl, so each nav
  // row becomes a bare icon with no tooltip and no accessible name. Borrow
  // the label text we just hid. Read from .sb-lbl rather than a static map so
  // rows added later (or relabelled per workspace) are covered for free.
  for (const item of document.querySelectorAll('.sidebar .sb-item')) {
    const label = item.querySelector('.sb-lbl')?.textContent.trim();
    if (!label) continue;
    if (collapsed) {
      item.setAttribute('title', label);
      item.setAttribute('aria-label', label);
    } else {
      item.removeAttribute('title');
      item.removeAttribute('aria-label');
    }
  }
  // The brand block is CSS-neutralised while collapsed (pointer-events:none),
  // but that doesn't stop the keyboard — drop it out of the tab order too.
  // Only when it's actually a switcher trigger; otherwise it has no tabindex.
  const logo = document.querySelector('.sidebar .sb-logo.switchable');
  if (logo) logo.setAttribute('tabindex', collapsed ? '-1' : '0');
}

// Read-only accessor for modules that wire the sidebar up asynchronously and
// so can't assume it is expanded (workspace-switcher/index.js).
export function isSidebarCollapsed() {
  return !!document.querySelector('.sidebar')?.classList.contains('collapsed');
}

export function toggleSidebar() {
  const next = !document.querySelector('.sidebar')?.classList.contains('collapsed');
  apply(next);
  persist(next);
}

registerActions({ 'app.toggleSidebar': () => toggleSidebar() });

// The nav rows and the workspace-switcher trigger are role="button" divs, and
// the shared dispatcher (core/event-delegation.js) only listens for click — so
// they were focusable but not operable. Bridge Enter/Space to a click here
// rather than in the dispatcher: a global keydown handler would also fire on
// [data-action] inputs, where Enter means something else. Scoped to the
// sidebar and to elements that actually claim role="button".
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const target = e.target.closest?.('.sidebar [role="button"][data-action]');
  if (!target) return;
  e.preventDefault();   // stop Space from scrolling the page
  target.click();
});

// The shell markup is static in index.html, so it already exists by the time
// this module is evaluated — no DOMContentLoaded wait needed.
apply(read());
