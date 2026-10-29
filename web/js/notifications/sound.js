import { SESSION } from '../core/state.js';
import { getWorkspaceId, getJwt } from '../core/api-client.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { showToast } from '../core/toast.js';

let audio;
const accountKey = () => SESSION?.userId && getWorkspaceId() ? `respovia_sound:${SESSION.userId}:${getWorkspaceId()}` : '';
function enabled() {
  try { return !!accountKey() && localStorage.getItem(accountKey()) === 'true'; } catch { return false; }
}
async function unlock() {
  try {
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) return false;
    audio ||= new Audio();
    if (audio.state !== 'running') await audio.resume();
    return audio.state === 'running';
  } catch { return false; }
}
function chime() {
  if (audio?.state !== 'running') return false;
  const tone = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime;
  tone.connect(gain); gain.connect(audio.destination);
  tone.frequency.setValueAtTime(660, now);
  tone.frequency.setValueAtTime(880, now + .12);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(.12, now + .015);
  gain.gain.exponentialRampToValueAtTime(.001, now + .32);
  tone.onended = () => { tone.disconnect(); gain.disconnect(); };
  tone.start(now); tone.stop(now + .34);
  return true;
}
for (const event of ['pointerdown', 'keydown']) {
  globalThis.document?.addEventListener(event, () => { if (enabled()) void unlock(); }, { passive: true });
}

export function queueSoundEvent(row, userId, now = Date.now()) {
  // shortcut: Sounds expire after 24 hours; use a durable inbox if offline alert history is needed.
  const at = new Date(row.queue_alert_at).getTime();
  if (!userId || row.assigned_user_id !== userId || row.deleted_at || row.merged_into_id
    || !['open', 'pending', 'escalated', 'gdpr'].includes(row.status_key)
    || (row.snoozed_until && new Date(row.snoozed_until).getTime() > now)
    || !row.queue_alert_at || !Number.isFinite(at) || at <= now - 86400000) return null;
  return `${row.id}:${row.queue_alert_at}`;
}
export async function notifyQueueSounds(rows) {
  const events = [];
  for (const row of rows) {
    const event = queueSoundEvent(row, SESSION?.userId);
    if (event) events.push(event);
  }
  if (!events.length || !enabled() || audio?.state !== 'running' || !globalThis.navigator?.locks) return;
  const key = accountKey(), jwt = getJwt();
  try {
    await navigator.locks.request(key, () => {
      if (key !== accountKey() || jwt !== getJwt() || !enabled()) return;
      // One chime per sync batch, shared across tabs for this account and workspace.
      const stored = JSON.parse(localStorage.getItem(key + ':heard') || '[]');
      const heard = Array.isArray(stored) ? stored.filter(v => typeof v === 'string' && new Date(v.slice(v.indexOf(':') + 1)).getTime() > Date.now() - 86400000) : [];
      if (events.every(id => heard.includes(id))) return;
      if (audio?.state !== 'running') return;
      localStorage.setItem(key + ':heard', JSON.stringify([...new Set([...heard, ...events])]));
      chime();
    });
  } catch { /* Storage or browser restrictions must not interrupt ticket sync. */ }
}
export function renderSoundSettings() {
  return `<div class="settings-section"><div class="settings-h">Queue sound</div>
    <p>Play a short sound when an email ticket is assigned to you or reopens in your queue. This setting applies to this account and workspace in this browser.</p>
    <div class="settings-row"><label><input type="checkbox" data-change-action="sound.toggle" ${enabled() ? 'checked' : ''}> Enable queue sound</label><button type="button" class="btn" data-action="sound.test">Test sound</button></div>
    <p class="appearance-hint">Keep Respovia open and interact with it once after opening it to allow sound. Your device must be unmuted.</p></div>`;
}
registerChangeActions({ 'sound.toggle': async (_, el) => {
  const key = accountKey();
  if (!key || !globalThis.navigator?.locks) { el.checked = false; showToast('Queue sound is unavailable in this browser or session.', 'error'); return; }
  try { localStorage.setItem(key, String(el.checked)); }
  catch { el.checked = false; showToast('Your browser could not save the sound setting.', 'error'); return; }
  if (el.checked && !await unlock()) showToast('Sound is blocked. Use Test sound to try again.', 'error');
} });
registerActions({ 'sound.test': async () => {
  if (await unlock()) chime();
  else showToast('Your browser could not play sound. Check its audio settings.', 'error');
} });
