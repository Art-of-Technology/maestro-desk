import { test, expect, mock } from 'bun:test';

const pending = [], clients = [];
let workspace = 'brand-a', syncs = 0, reloads = 0;
mock.module('../web/js/core/api-client.js', () => ({
  API_BASE: '', getJwt: () => 'test', getWorkspaceId: () => workspace,
  apiGet: () => new Promise(resolve => pending.push(resolve)),
}));
mock.module('../web/js/vendor/pubby.js', () => ({ default: { Pubby: class {
  constructor() { clients.push(this); }
  connect() {}
  disconnect() { this.disconnected = true; }
  subscribe() { return { bind: (_, callback) => { this.callback = callback; } }; }
} } }));
mock.module('../web/js/tickets/list-sync.js', () => ({ tick: async () => { syncs++; } }));
mock.module('../web/js/tickets/detail.js', () => ({ reloadTicketByUuid: () => { reloads++; } }));
mock.module('../web/js/notifications/index.js', () => ({ maybeToastNewResponse() {} }));
const { startRealtime, stopRealtime } = await import('../web/js/core/realtime.js');

test('leaving and re-entering the same brand cancels old connections and callbacks', async () => {
  const old = startRealtime();
  stopRealtime();
  const current = startRealtime();
  pending.shift()({ key: 'test', ws_host: 'test' });
  await old;
  expect(clients).toHaveLength(0);
  pending.shift()({ key: 'test', ws_host: 'test' });
  await current;
  expect(clients).toHaveLength(1);
  await clients[0].callback({ id: 'ticket' });
  expect(syncs).toBe(1);
  expect(reloads).toBe(1);
  stopRealtime();
  await clients[0].callback({ id: 'ticket' });
  expect(syncs).toBe(1);
  expect(reloads).toBe(1);
  expect(clients[0].disconnected).toBe(true);
  workspace = null;
  await startRealtime();
  expect(pending).toHaveLength(0);
});
