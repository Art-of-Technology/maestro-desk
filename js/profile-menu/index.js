// ─── Profile menu ────────────────────────────────────────────────────────────
// Top-bar avatar dropdown with shortcuts to Profile / Settings / Help /
// Translator / Sign out. The dropdown markup lives in index.html
// (#profile-btn + #profile-dropdown); this module just owns the open/close
// toggle and the action dispatcher.
//
// External reaches (interim, via window): navTo, logout — still in app.js.
//
// showTranslatorModal is imported directly from ai/translate.js since it's
// already a proper export there.

import { showTranslatorModal } from '../ai/translate.js';

export function toggleProfileMenu() {
  const dd = document.getElementById('profile-dropdown');
  const btn = document.getElementById('profile-btn');
  if (!dd) return;
  if (dd.classList.contains('show')) { dd.classList.remove('show'); btn?.classList.remove('active'); }
  else { dd.classList.add('show'); btn?.classList.add('active'); }
}

export function profileMenuGo(action) {
  document.getElementById('profile-dropdown')?.classList.remove('show');
  document.getElementById('profile-btn')?.classList.remove('active');
  if (action === 'profile')        { window.navTo('profile'); }
  else if (action === 'settings')  { window.navTo('settings'); }
  else if (action === 'help')      { window.navTo('help'); }
  else if (action === 'translator'){ showTranslatorModal(''); }
  else if (action === 'signout')   { window.logout(); }
}
