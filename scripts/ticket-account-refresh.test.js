import { beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

let bundle;
const shim = readFileSync(new URL('./bridge-smoke-shim-prefix.js', import.meta.url), 'utf8');
beforeAll(async () => {
  const web = resolve(import.meta.dir, '../web/js').replaceAll('\\', '/');
  const build = await Bun.build({
    entrypoints: ['ticket-refresh-test'], target: 'browser', format: 'iife',
    define: { 'import.meta.url': '"https://app.example.test/js/app.js"' },
    plugins: [{ name: 'ticket-refresh-test', setup(builder) {
      builder.onResolve({ filter: /^ticket-refresh-test$/ }, () => ({ path: 'entry', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ loader: 'js', contents: `
        import '${web}/app.js';
        import { openTicket } from '${web}/tickets/detail.js';
        import { CUSTOMERS, TICKETS } from '${web}/core/data.js';
        import { setJwt, setWorkspaceId } from '${web}/core/api-client.js';
        Object.assign(globalThis, { openTicket, customers: CUSTOMERS, tickets: TICKETS, setJwt, setWorkspaceId });
      ` }));
    } }],
  });
  if (!build.success) throw new Error(build.logs.join('\n'));
  bundle = await build.outputs[0].text();
});

function setup() {
  let now = 100_000;
  const context = { console, Date: class extends Date { static now() { return now; } },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, URL,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    CustomEvent: class { constructor(type) { this.type = type; } } };
  runInNewContext(shim, context);
  runInNewContext(bundle, context);
  const nodes = new Map();
  context.document.getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, context._node());
    return nodes.get(id);
  };
  context.setJwt('session-A');
  context.setWorkspaceId('workspace-A');
  const ticket = context.tickets[0];
  const customer = context.customers.find(c => c.id === ticket.customerId);
  Object.assign(customer, { _uuid: 'customer-uuid', maestroUserId: null, brand: '', vip: '', bo: '' });
  const panel = context.document.getElementById('ticket-customer');
  panel.dataset.custId = customer.id;
  const calls = [];
  let complete;
  context.fetch = (url, options) => {
    if (!String(url).endsWith('/refresh-account')) return Promise.resolve(new Response('{}'));
    calls.push({ url, options });
    return new Promise(resolve => { complete = resolve; });
  };
  return { context, ticket, customer, panel, calls, nodes,
    open: () => context.openTicket(ticket.id),
    advance: () => { now += 61_000; },
    respond: (status = 200) => complete(new Response(JSON.stringify(status === 200 ? { customer: {
      id: 'customer-uuid', display_id: customer.id, maestro_user_id: '50724',
      first_name: 'Francisco', last_name: 'Test', username: 'javier1107', brand: 'Space Casino',
      vip_tier: 'Gold', jurisdiction: 'MX', backoffice_url: 'https://bo.spacecasino.com/Member/Detail/50724',
    } } : { error: "Couldn't refresh account details. Try opening this profile again shortly." }), { status })),
  };
}

async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

test('opening an unlinked ticket refreshes only the customer panel and preserves the composer', async () => {
  const h = setup();
  h.open();
  const main = h.context.document.getElementById('main');
  const rendered = main.innerHTML;
  const composer = h.context.document.getElementById('compose-input-' + h.ticket.id);
  composer.value = 'Unsent reply';
  h.respond(); await settle();
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].options.headers['X-Workspace-Id']).toBe('workspace-A');
  expect(h.customer.maestroUserId).toBe('50724');
  expect(h.panel.innerHTML).toContain('Space Casino');
  expect(h.panel.innerHTML).toContain('/Member/Detail/50724');
  expect(main.innerHTML).toBe(rendered);
  expect(composer.value).toBe('Unsent reply');
  h.open(); expect(h.calls).toHaveLength(1);
});

test('failed lookups retry on a later open, with no duplicates or retries inside the cooldown', async () => {
  const h = setup(); h.open(); h.open();
  expect(h.calls).toHaveLength(1);
  h.respond(502); await settle();
  expect(h.customer.maestroUserId).toBeNull();
  h.open(); expect(h.calls).toHaveLength(1);
  h.advance(); h.open(); expect(h.calls).toHaveLength(2);
  h.respond(); await settle();
  expect(h.customer.maestroUserId).toBe('50724');
});

test('linked, demo, erased and merged customers do not trigger ticket lookups', () => {
  for (const extra of [{ maestroUserId: '50724' }, { _uuid: null }, { erased: true }, { mergedInto: 'M1' }]) {
    const h = setup(); Object.assign(h.customer, extra); h.open();
    expect(h.calls).toHaveLength(0);
  }
});

test('late results cannot repaint another customer or import data after switching workspace', async () => {
  for (const drift of ['ticket', 'workspace']) {
    const h = setup(); h.open();
    if (drift === 'workspace') h.context.setWorkspaceId('workspace-B');
    else h.panel.dataset.custId = 'another-customer';
    h.panel.innerHTML = 'Keep current panel';
    h.respond(); await settle();
    expect(h.panel.innerHTML).toBe('Keep current panel');
    if (drift === 'workspace') expect(h.customer.maestroUserId).toBeNull();
  }
});
