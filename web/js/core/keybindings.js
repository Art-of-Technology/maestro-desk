// ─── App-wide keybindings + navigation helpers ──────────────────────────────
// Two named exports plus a side-effect keydown listener:
//
//   - navTo(page)            — sidebar-style nav from any context. Thin wrapper
//                              over nav(page) (core/router.js), which resolves
//                              and highlights the owning sidebar item itself.
//   - focusGlobalSearch()    — focuses the #gs-input and selects it. Called
//                              from an inline onclick in help/index.js, so
//                              the window-bridge entry is required.
//   - keydown listener       — `/` focuses global search when not typing in a
//                              field; Cmd-K / Ctrl-K opens the quick switcher
//                              from anywhere, including inside text inputs.

import { nav } from './router.js';
import { toggleQuickSwitcher } from '../quick-switcher/index.js';
import { CURRENT_TICKET } from './state.js';
import { showMacroPanel } from '../tickets/macros.js';

export function navTo(page) {
  nav(page);
}

export function focusGlobalSearch() {
  const input = document.getElementById('gs-input');
  if (input) { input.focus(); input.select(); }
}

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && !e.isComposing && !e.repeat
      && CURRENT_TICKET && !document.querySelector('#modal-container .modal')) {
    const editor = document.getElementById('compose-' + CURRENT_TICKET);
    const button = document.querySelector('[data-action="td.macroPanel"]');
    if (button && !button.disabled && (editor?.contains(document.activeElement) || document.activeElement === button)) {
      e.preventDefault();
      showMacroPanel(CURRENT_TICKET);
      return;
    }
  }
  if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      const input = document.getElementById('gs-input');
      if (input) { e.preventDefault(); input.focus(); input.select(); }
    }
  }
  // Cmd+K / Ctrl+K opens the quick switcher from anywhere — including inside
  // text inputs, since this is the standard shortcut agents reach for.
  if (e.key === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey) {
    e.preventDefault();
    toggleQuickSwitcher(true);
  }
});
