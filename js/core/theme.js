// ─── Theme ───────────────────────────────────────────────────────────────────
// First real ES module in the codebase. Exports `THEME` (live binding),
// `applyTheme`, and `setTheme`. The init code (matchMedia listener + first
// apply) runs at module load.

export let THEME = localStorage.getItem('theme') || 'system';

export function applyTheme(t) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const useDark = t === 'dark' || (t === 'system' && prefersDark);
  document.documentElement.classList.toggle('light', !useDark);
}

export function setTheme(t) {
  THEME = t;
  localStorage.setItem('theme', t);
  applyTheme(t);
}

// Re-apply when the OS preference flips while we're in `system` mode.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (THEME === 'system') applyTheme('system');
});

// Apply on initial load (avoids a flash of the wrong palette).
applyTheme(THEME);
