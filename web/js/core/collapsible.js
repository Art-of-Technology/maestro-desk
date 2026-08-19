// ─── Collapsible sections ───────────────────────────────────────────────────
// After each renderPage we inject a small caret into every .kpi-bar /
// .filter-bar / .tab-bar so an agent can hide chrome they don't need today.
// Section IDs are page-scoped + indexed within the page, so a page with
// multiple bars of the same kind tracks them independently. Because the index
// is positional, adding or removing a bar remaps every later id on that page —
// see RETIRED_SECTION_IDS below before you change a page's bar composition.
//
// Cross-cutting concern (used by every page), so it lives under js/core/.
//
// CURRENT_PAGE + SETTINGS_TAB are imported from core/state.js.
//
// COLLAPSED_SECTIONS is exported because Settings → Appearance reads its
// .size for the "N section(s) collapsed" counter + the "Show all" button's
// disabled state. ES module bindings are live so the imported reference
// in app.js sees mutations made here.
import { CURRENT_PAGE, SETTINGS_TAB } from './state.js';
import { renderPage } from './router.js';

export let COLLAPSED_SECTIONS = new Set(JSON.parse(localStorage.getItem('collapsed_sections') || '[]'));
const SEC_LABELS = {
  'kpi-bar':    'KPIs',
  'filter-bar': 'Filters',
  'tab-bar':    'Tabs',
};

function persistCollapsedSections() {
  localStorage.setItem('collapsed_sections', JSON.stringify([...COLLAPSED_SECTIONS]));
}

// ─── Retired section ids ────────────────────────────────────────────────────
// Because ids are positional, removing a bar from a page doesn't just orphan
// its stored id — nothing ever prunes it, and the counter in Settings →
// Appearance would keep counting a section the user can no longer see or
// restore. Any change that deletes a bar adds its id here.
//
// tickets:filter-bar:1 — the tickets page's second filter bar (View chips +
// saved searches) was merged into the first in #447, so only :0 now exists.
const RETIRED_SECTION_IDS = ['tickets:filter-bar:1'];

(function pruneRetiredSections() {
  let changed = false;
  for (const id of RETIRED_SECTION_IDS) {
    if (COLLAPSED_SECTIONS.delete(id)) changed = true;
  }
  // Guarded: this runs at module evaluation, so an unguarded quota or
  // private-mode failure here would take down app boot. The in-memory prune
  // has already happened either way; only the write-back is best-effort.
  if (changed) { try { persistCollapsedSections(); } catch { /* re-pruned next load */ } }
})();

// Single source of truth for class + caret + aria sync. Both the post-render
// initial pass and the click handler call this so the visible state can't
// drift out of sync with COLLAPSED_SECTIONS.
function syncCollapsedSectionDom(el, id) {
  if (!el) return;
  const collapsed = COLLAPSED_SECTIONS.has(id);
  el.classList.toggle('sec-collapsed', collapsed);
  const caret = el.querySelector(':scope > .sec-caret');
  if (caret) {
    // When expanded, the caret carries a clear "Hide" label so it's
    // discoverable. When collapsed the whole bar is the affordance, so
    // the caret reduces to a small chevron next to the "▸ Show …" label.
    caret.innerHTML = collapsed ? '▸' : '▾&nbsp;Hide';
    caret.title = collapsed ? 'Show section' : 'Hide section';
    caret.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
}

function toggleSection(id, event) {
  if (event) event.stopPropagation();
  if (COLLAPSED_SECTIONS.has(id)) COLLAPSED_SECTIONS.delete(id);
  else COLLAPSED_SECTIONS.add(id);
  persistCollapsedSections();
  // Mutate the live element so input focus / scroll / bulk-selection survive.
  syncCollapsedSectionDom(document.querySelector(`[data-sec-id="${CSS.escape(id)}"]`), id);
  // Settings → Appearance shows a counter of hidden sections; re-render so
  // the count and the "Show all" button's disabled state stay current.
  if (CURRENT_PAGE === 'settings' && SETTINGS_TAB === 'appearance') renderPage('settings');
}

export function applyCollapsibleHeaders() {
  const sels = ['.kpi-bar', '.filter-bar', '.tab-bar'];
  const page = CURRENT_PAGE || 'page';
  sels.forEach(sel => {
    document.querySelectorAll(sel).forEach((el, i) => {
      // Stable id per page + kind + index. A page with multiple filter bars
      // (tickets has two) tracks each independently.
      const kind = sel.slice(1);
      const id = `${page}:${kind}:${i}`;
      el.dataset.secId = id;
      el.dataset.collapsedLabel = '▸ Show ' + (SEC_LABELS[kind] || 'section');
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      if (!el.querySelector(':scope > .sec-caret')) {
        const btn = document.createElement('button');
        btn.className = 'sec-caret';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Toggle section');
        btn.addEventListener('click', e => toggleSection(id, e));
        el.appendChild(btn);
        // Whole-bar click expands when collapsed. Element is fresh on every
        // page render (innerHTML replacement) so we can bind without a
        // double-bind guard.
        el.addEventListener('click', e => {
          if (!el.classList.contains('sec-collapsed')) return;
          if (e.target.closest('.sec-caret')) return;
          toggleSection(id, e);
        });
      }
      syncCollapsedSectionDom(el, id);
    });
  });
}

export function resetAllCollapsedSections() {
  COLLAPSED_SECTIONS.clear();
  persistCollapsedSections();
  renderPage(CURRENT_PAGE || 'dashboard');
}
