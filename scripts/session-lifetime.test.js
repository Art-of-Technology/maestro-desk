import { test, expect, mock, afterAll } from 'bun:test';

const originals = { now: Date.now, setTimeout, clearTimeout };
let now = Date.parse('2026-09-23T08:00:00Z');
let jwt = 'session-a';
let scheduled;
let focused = true;
const stored = new Map();
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => focused });
globalThis.sessionStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
Date.now = () => now;
globalThis.setTimeout = (fn, delay) => { scheduled = { fn, delay }; return 1; };
globalThis.clearTimeout = () => { scheduled = null; };
mock.module('../web/js/core/api-client.js', () => ({ getJwt: () => jwt }));
const { startSessionLifetime, stopSessionLifetime } = await import('../web/js/core/session-lifetime.js');
afterAll(() => { Date.now = originals.now; globalThis.setTimeout = originals.setTimeout; globalThis.clearTimeout = originals.clearTimeout; });

test('fixed expiry, active warning, reload deduplication, sleeping tabs and stale sessions', () => {
  let warnings = [];
  let expired = 0;
  window.addEventListener('respovia:session-warning', e => warnings.push(e.detail.minutes));
  window.addEventListener('respovia:session-expired', () => expired++);
  const start = now;
  const end = start + 8 * 3600000;
  const session = () => ({ expiresAt: new Date(end).toISOString(), serverTime: new Date(now).toISOString() });
  startSessionLifetime(session(), jwt);
  expect(scheduled.delay).toBe(7.5 * 3600000);
  now = end - 30 * 60000;
  scheduled.fn();
  expect(warnings).toEqual([30]);
  expect(scheduled.delay).toBe(30 * 60000);
  startSessionLifetime(session(), jwt); // Reload/rehydration keeps the original deadline.
  window.dispatchEvent(new Event('focus'));
  expect(warnings).toEqual([30]);
  now = end;
  scheduled.fn();
  expect(expired).toBe(1);
  expect(scheduled).toBeNull();

  stored.clear();
  jwt = 'session-b';
  now = end - 30 * 60000;
  focused = false;
  document.visibilityState = 'hidden';
  startSessionLifetime(session(), jwt);
  expect(warnings).toEqual([30]);
  now += 5 * 60000;
  focused = true;
  document.visibilityState = 'visible';
  window.dispatchEvent(new Event('focus'));
  expect(warnings).toEqual([30, 25]);
  document.visibilityState = 'hidden';
  now = end + 60000; // Timers were suspended while the computer slept.
  window.dispatchEvent(new Event('pageshow'));
  expect(expired).toBe(2);

  now = start;
  startSessionLifetime(session(), jwt);
  jwt = 'new-login';
  now = end;
  scheduled.fn();
  expect(expired).toBe(2); // Old timer must not expire the new login.
  expect(() => startSessionLifetime(session(), jwt)).toThrow('expired');
  expect(expired).toBe(3);
  expect(() => startSessionLifetime({}, jwt)).toThrow('verify');
  stopSessionLifetime();
});
