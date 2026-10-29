import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync('web/js/notifications/sound.js', 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '');
function setup(storage = new Map(), locks = { request: async (_, fn) => fn() }) {
  let played = 0;
  const actions = {}, changes = {};
  const ctx = { SESSION: { userId: 'me' }, TICKETS: [], CHANNELS: [{ _uuid: 'email', type: 'email' }],
    Date: class extends Date { static now() { return new Date('2026-10-29T13:00:00Z').getTime(); } },
    workspace: 'one', jwt: 'session', getWorkspaceId: () => ctx.workspace, getJwt: () => ctx.jwt,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, val) => storage.set(key, val) },
    navigator: { locks }, showToast() {}, registerActions: map => Object.assign(actions, map),
    registerChangeActions: map => Object.assign(changes, map),
    AudioContext: class {
      state = 'running'; currentTime = 0;
      createOscillator() { return { connect() {}, disconnect() {}, frequency: { setValueAtTime() {} }, start() { played++; }, stop() {} }; }
      createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
    },
  };
  runInNewContext(source, ctx);
  return { ctx, actions, changes, storage, played: () => played,
    enable: () => changes['sound.toggle']({}, { checked: true }) };
}
const row = (changes = {}) => ({ id: 'ticket', assigned_user_id: 'me', status_key: 'open', channel_id: 'email', queue_alert_at: '2026-10-29T12:00:00Z', ...changes });
test('only assignment and reopen into my active queue qualify', () => {
  const { ctx: { queueSoundEvent: event } } = setup();
  expect(event(row(), 'me')).toBe('ticket:2026-10-29T12:00:00Z');
  for (const changes of [{ queue_alert_at: null }, { queue_alert_at: 'invalid' }, { assigned_user_id: 'other' }, { status_key: 'closed' }, { deleted_at: 'today' }, { merged_into_id: 'other' }, { snoozed_until: '2099-01-01' }]) {
    expect(event(row(changes), 'me')).toBeNull();
  }
});
test('silent by default; ordinary edits and duplicate events do not chime', async () => {
  const s = setup();
  await s.ctx.notifyQueueSounds([row()]); expect(s.played()).toBe(0);
  await s.enable(); await s.ctx.notifyQueueSounds([row({ queue_alert_at: null })]); expect(s.played()).toBe(0);
  await s.ctx.notifyQueueSounds([row()]); await s.ctx.notifyQueueSounds([row()]); expect(s.played()).toBe(1);
  await s.ctx.notifyQueueSounds([row({ queue_alert_at: '2026-10-29T12:03:00Z' })]); expect(s.played()).toBe(2);
});
test('email only, one chime per batch and per event across tabs', async () => {
  const storage = new Map();
  let tail = Promise.resolve();
  const locks = { request: (_, fn) => tail = tail.then(fn) };
  const a = setup(storage, locks), b = setup(storage, locks);
  await a.enable(); await b.enable();
  const rows = [row(), row({ id: 'second' })];
  await Promise.all([a.ctx.notifyQueueSounds(rows), b.ctx.notifyQueueSounds(rows)]);
  expect(a.played() + b.played()).toBe(1);
  await a.ctx.notifyQueueSounds([row({ id: 'portal', channel_id: 'portal', queue_alert_at: null })]); expect(a.played()).toBe(1);
  const burst = Array.from({ length: 500 }, (_, i) => row({ id: `burst-${i}` }));
  await Promise.all([a.ctx.notifyQueueSounds(burst), b.ctx.notifyQueueSounds(burst)]);
  expect(a.played() + b.played()).toBe(2);
});
test('workspace/session changes and disabled sound suppress queued callbacks', async () => {
  let release;
  const s = setup(new Map(), { request: (_, fn) => new Promise(resolve => { release = () => { fn(); resolve(); }; }) });
  await s.enable();
  const pending = s.ctx.notifyQueueSounds([row()]); s.ctx.workspace = 'two'; release(); await pending;
  expect(s.played()).toBe(0);
  s.ctx.workspace = 'one';
  const next = s.ctx.notifyQueueSounds([row({ id: 'next' })]); s.ctx.jwt = 'replacement'; release(); await next;
  expect(s.played()).toBe(0);
});
