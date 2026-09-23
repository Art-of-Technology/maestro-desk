import { getJwt } from './api-client.js';

const WARNING_MS = 30 * 60 * 1000;
const WARNED_KEY = 'respovia_session_warning';
let timer = null;
let token = null;
let deadline = 0;
let expiry = '';

export function stopSessionLifetime() {
  clearTimeout(timer);
  timer = null;
  token = null;
}

export function startSessionLifetime(session, sessionToken) {
  if (!sessionToken || getJwt() !== sessionToken) return;
  const remaining = Date.parse(session?.expiresAt) - Date.parse(session?.serverTime);
  if (!Number.isFinite(remaining)) throw new Error('Could not verify your session expiry. Please sign in again.');
  stopSessionLifetime();
  token = sessionToken;
  expiry = session.expiresAt;
  // Use the server's remaining lifetime, so a different local timezone or clock
  // does not make a freshly loaded session expire early or last longer.
  deadline = Date.now() + remaining;
  checkSessionLifetime();
  if (remaining <= 0) throw new Error('Your session has expired. Please sign in again.');
}

function checkSessionLifetime() {
  if (!token || getJwt() !== token) return stopSessionLifetime();
  clearTimeout(timer);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    stopSessionLifetime();
    window.dispatchEvent(new CustomEvent('respovia:session-expired'));
    return;
  }
  if (remaining <= WARNING_MS && document.visibilityState === 'visible' && document.hasFocus()
      && sessionStorage.getItem(WARNED_KEY) !== expiry) {
    sessionStorage.setItem(WARNED_KEY, expiry);
    window.dispatchEvent(new CustomEvent('respovia:session-warning', {
      detail: { minutes: Math.ceil(remaining / 60000) },
    }));
  }
  timer = setTimeout(checkSessionLifetime, remaining > WARNING_MS ? remaining - WARNING_MS : remaining);
}

document.addEventListener('visibilitychange', checkSessionLifetime);
window.addEventListener('focus', checkSessionLifetime);
window.addEventListener('pageshow', checkSessionLifetime);
