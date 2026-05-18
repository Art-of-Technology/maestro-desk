// ─── Global click-outside / dismiss handler ─────────────────────────────────
// Closes the open dropdown panels (global-search results, notifications,
// profile menu) and any visible `.comp-menu` when the user clicks outside
// the originating wrapper. Each panel module *opens* its own dropdown; this
// is the one place that gets to close them on outside-click so we don't
// have N copies of the same `mousedown` listener.
//
// Side-effect-only module — importing it once at app startup is what
// registers the listener; no exports.

document.addEventListener('mousedown', e => {
  const wrap = document.querySelector('.gs-wrap');
  const results = document.getElementById('gs-results');
  if (wrap && results && !wrap.contains(e.target)) results.classList.remove('show');
  const notifWrap = document.querySelector('.notif-wrap');
  const notifDD = document.getElementById('notif-dropdown');
  if (notifWrap && notifDD && !notifWrap.contains(e.target)) notifDD.classList.remove('show');
  const profileWrap = document.querySelector('.profile-wrap');
  const profileDD = document.getElementById('profile-dropdown');
  if (profileWrap && profileDD && !profileWrap.contains(e.target)) {
    profileDD.classList.remove('show');
    document.getElementById('profile-btn')?.classList.remove('active');
  }
  document.querySelectorAll('.comp-menu').forEach(menu => {
    if (menu.style.display === 'block' && !menu.parentElement.contains(e.target)) {
      menu.style.display = 'none';
    }
  });
});
