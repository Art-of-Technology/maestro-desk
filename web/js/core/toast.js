// Minimal transient toast. A fixed bottom-right pill that auto-dismisses —
// used for non-blocking status (e.g. "✓ Emailed to customer") where an
// alert() would be too intrusive. Survives a page re-render because it
// attaches to <body>, outside the app's render root.
//
// kind: 'success' | 'warn' | 'error' | 'info' (default 'info').

const COLORS = {
  success: 'var(--green, #16a34a)',
  warn:    'var(--amber, #d97706)',
  error:   'var(--red, #dc2626)',
  info:    'var(--ink2, #475569)',
};

export function showToast(message, kind = 'info', ms = 4000, onClick = null) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.style.cssText = `pointer-events:auto;max-width:340px;padding:10px 14px;border-radius:10px;background:var(--bg,#fff);color:var(--ink,#0f172a);font-size:13px;line-height:1.4;box-shadow:0 8px 24px -8px rgba(0,0,0,0.4);border-left:3px solid ${COLORS[kind] || COLORS.info};opacity:0;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease`;
  el.textContent = message;
  if (onClick) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => { try { onClick(); } finally { el.remove(); } });
  }
  host.appendChild(el);
  // Next frame: animate in.
  requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 200);
  }, ms);
}
