// Web Push opt-in (offline-agent notifications). Manages the service-worker
// registration + browser PushSubscription and renders the Settings →
// Notifications "browser notifications on this device" control. Delivery
// (pushing the offline assigned agent on a reply) is server-side, stage 3.
//
// Gating: the opt-in only appears when the browser supports push AND the
// server reports VAPID configured (GET /push/config). Push is inherently
// per-device + per-browser and opt-in via the OS permission prompt.

import { apiGet, apiPost } from '../core/api-client.js';
import { renderPage } from '../core/router.js';
import { showToast } from '../core/toast.js';
import { registerActions } from '../core/event-delegation.js';

let CONFIG = null;            // { configured, public_key } — fetched once
let STATE = null;             // { supported, configured, permission, subscribed }
let STATE_LOADED = false;

function supported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// VAPID public key (base64url) → Uint8Array for applicationServerKey.
function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function getConfig() {
  if (CONFIG) return CONFIG;
  try { CONFIG = await apiGet('/api/v1/push/config'); } catch { CONFIG = { configured: false, public_key: null }; }
  return CONFIG;
}

async function getRegistration() {
  // Reuse an existing registration; only register the SW when we actually
  // need it (on enable / status check) so we don't add a worker for agents
  // who never opt in.
  const existing = await navigator.serviceWorker.getRegistration('/sw.js');
  return existing || null;
}

async function refreshState() {
  const sup = supported();
  const cfg = await getConfig();
  let permission = sup ? Notification.permission : 'unsupported';
  let subscribed = false;
  if (sup && cfg.configured) {
    const reg = await getRegistration();
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      subscribed = Boolean(sub);
    }
  }
  STATE = { supported: sup, configured: Boolean(cfg.configured), permission, subscribed };
  return STATE;
}

async function enablePush() {
  const cfg = await getConfig();
  if (!cfg.configured || !cfg.public_key) { showToast('Push notifications aren’t configured on the server.', 'warn'); return; }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast(permission === 'denied'
        ? 'Notifications are blocked — enable them in your browser’s site settings.'
        : 'Notification permission was dismissed.', 'warn', 6000);
      await refreshState(); renderPage('settings');
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(cfg.public_key),
    });
    // Send just the fields the API reads (endpoint + keys). toJSON() also
    // carries expirationTime; the server strips unknown fields, so this is
    // payload hygiene, not a requirement.
    const { endpoint, keys } = sub.toJSON();
    await apiPost('/api/v1/push/subscribe', { endpoint, keys });
    showToast('✓ Browser notifications enabled on this device', 'success');
  } catch (err) {
    showToast(`Couldn’t enable notifications: ${err?.message || err}`, 'error', 6000);
  }
  await refreshState(); renderPage('settings');
}

async function disablePush() {
  try {
    const reg = await getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await apiPost('/api/v1/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    showToast('Browser notifications disabled on this device', 'info');
  } catch (err) {
    showToast(`Couldn’t disable: ${err?.message || err}`, 'error');
  }
  await refreshState(); renderPage('settings');
}

async function sendTest() {
  try {
    const res = await apiPost('/api/v1/push/test');
    showToast(res?.sent > 0 ? 'Test notification sent — check your desktop.' : 'No active devices to notify.', res?.sent > 0 ? 'success' : 'warn', 6000);
  } catch (err) {
    showToast(`Test failed: ${err?.message || err}`, 'error');
  }
}

// Rendered inside Settings → Notifications. Lazy-loads device state on first
// paint and re-renders once known.
export function settingsPushSection() {
  if (!STATE_LOADED) {
    STATE_LOADED = true;
    refreshState().then(() => renderPage('settings')).catch(() => {});
  }
  const s = STATE;
  let control;
  if (!s) {
    control = `<div style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace">Checking…</div>`;
  } else if (!s.supported) {
    control = `<div style="font-size:11px;color:var(--ink3)">This browser doesn’t support push notifications.</div>`;
  } else if (!s.configured) {
    control = `<div style="font-size:11px;color:var(--ink3)">Push notifications aren’t configured on the server yet.</div>`;
  } else if (s.permission === 'denied') {
    control = `<div style="font-size:11px;color:var(--amber)">Blocked in your browser. Enable notifications for this site in your browser’s site settings, then reload.</div>`;
  } else if (s.subscribed) {
    control = `<div style="display:flex;gap:8px;align-items:center">
      <span style="font-size:11px;color:var(--green);font-family:'DM Mono',monospace">✓ Enabled on this device</span>
      <button class="btn btn-sm" data-action="push.test">Send test</button>
      <button class="btn btn-sm btn-danger" data-action="push.disable">Disable</button>
    </div>`;
  } else {
    control = `<button class="btn btn-solid btn-sm" data-action="push.enable">Enable on this device</button>`;
  }
  return `
    <div class="settings-section">
      <div class="settings-h">Browser notifications</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        Get a desktop notification when a customer replies to a ticket assigned to you — even when Respovia isn’t the active tab. Per device: enable it on each browser you want alerts on.
      </div>
      ${control}
    </div>`;
}

registerActions({
  'push.enable':  () => enablePush(),
  'push.disable': () => disablePush(),
  'push.test':    () => sendTest(),
});
