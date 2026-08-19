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
}

export function toggleSidebar() {
  const next = !document.querySelector('.sidebar')?.classList.contains('collapsed');
  apply(next);
  persist(next);
}

registerActions({ 'app.toggleSidebar': () => toggleSidebar() });

// The shell markup is static in index.html, so it already exists by the time
// this module is evaluated — no DOMContentLoaded wait needed.
apply(read());
