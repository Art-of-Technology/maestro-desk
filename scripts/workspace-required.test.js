import { test, expect } from 'bun:test';
import './bridge-smoke-shim-prefix.js';

const nodes = new Map();
const makeNode = document.getElementById;
document.getElementById = id => {
  if (!nodes.has(id)) nodes.set(id, makeNode());
  return nodes.get(id);
};
window.escHtml = window.escAttr = value => String(value ?? '');
const { renderPage } = await import('../web/js/core/router.js');
const { setJwt, setWorkspaceId } = await import('../web/js/core/api-client.js');
const { loadWorkQueue, workQueueState } = await import('../web/js/tickets/work-queue.js');
const { tick, stopListSync } = await import('../web/js/tickets/list-sync.js');
const { renderNotificationsPage } = await import('../web/js/notifications/index.js');
const { setSession } = await import('../web/js/core/state.js');
const { resumeUrlRouting } = await import('../web/js/core/url-navigation.js');

test('admin routes, queue and notifications wait for a brand, then recover after selection', async () => {
  const reads = [];
  globalThis.fetch = async url => {
    reads.push(String(url));
    return { ok: true, text: async () => JSON.stringify({ tickets: [], cursor: 'test', next: null }) };
  };
  setJwt('test-session');
  setWorkspaceId(null);
  setSession({ role: 'Platform Admin', name: 'Test', userId: 'test' });
  sessionStorage.setItem('maestro_user', JSON.stringify({ is_platform_admin: true }));
  for (const page of ['dashboard', 'tickets', 'customers', 'reports', 'notifications', 'config']) {
    renderPage(page);
    expect(document.getElementById('main-area').innerHTML).toContain('Choose brand');
  }
  await loadWorkQueue();
  await tick();
  expect(reads).toEqual([]);
  expect(document.getElementById('nb-open').style.display).toBe('none');
  expect(document.getElementById('notif-badge').style.display).toBe('none');
  expect(renderNotificationsPage()).toContain('Choose a brand to view notifications');
  expect(renderNotificationsPage()).not.toContain('data-ticket-id=');

  // A saved workspace-less URL follows the same guard on reload.
  window.location.hash = '#/tickets';
  await resumeUrlRouting();
  expect(document.getElementById('main-area').innerHTML).toContain('Choose brand');
  expect(reads).toEqual([]);

  window.location.hash = '#/tickets/TK-001';
  await resumeUrlRouting();
  expect(document.getElementById('main-area').innerHTML).toContain('Choose brand');
  expect(reads).toEqual([]);

  setWorkspaceId('brand-a');
  await loadWorkQueue();
  expect(workQueueState().ready).toBe(true);
  await tick();
  expect(reads.some(url => url.includes('/tickets/sync'))).toBe(true);
  renderPage('tickets');
  expect(document.getElementById('main-area').innerHTML).not.toContain('Choose brand');
  expect(document.getElementById('nb-open').style.display).toBe('');

  // Leaving a brand must not expose the previous brand's cached notifications.
  setWorkspaceId(null);
  reads.length = 0;
  renderPage('tickets');
  await tick();
  await loadWorkQueue();
  expect(reads).toEqual([]);
  expect(document.getElementById('nb-open').style.display).toBe('none');
  expect(renderNotificationsPage()).not.toContain('data-ticket-id=');

  setWorkspaceId('brand-b');
  await loadWorkQueue();
  expect(workQueueState().ready).toBe(true);
  setJwt(null);
  setWorkspaceId(null);
  renderPage('tickets');
  expect(document.getElementById('main-area').innerHTML).not.toContain('Choose brand');
  stopListSync();
});
