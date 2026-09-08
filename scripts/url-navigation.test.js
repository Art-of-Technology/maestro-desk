import { beforeEach, describe, expect, it, mock } from 'bun:test';

const ws = '11111111-1111-4111-8111-111111111111';
const otherWs = '22222222-2222-4222-8222-222222222222';
const ticketId = '44444444-4444-4444-8444-444444444444';
const customerId = '33333333-3333-4333-8333-333333333333';
const saved = new Map();
globalThis.localStorage = globalThis.sessionStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
  removeItem: key => saved.delete(key),
  get length() { return saved.size; },
  key: index => [...saved.keys()][index] ?? null,
};
const state = await import('../web/js/core/state.js');
const TICKETS = [], CUSTOMERS = [], pushes = [], warnings = [], reads = [];
let workspaceId, workspaceSlug, jwt, reloads, fetchTicket, platformAdmin, bootCount, whoami;
const elements = new Map();
globalThis.document = { getElementById: id => {
  if (!elements.has(id)) elements.set(id, { style: {}, innerHTML: '', textContent: '', addEventListener() {} });
  return elements.get(id);
} };
globalThis.window = {
  location: { hash: '', pathname: '/', search: '', reload: () => reloads++ },
  login: (role, name, initials, options) => {
    state.setSession({ role, name, initials, ...options }); state.setCurrentPage('dashboard');
  },
};
globalThis.history = {
  pushState: (_state, _title, hash) => { pushes.push(hash); window.location.hash = hash; },
  replaceState: (_state, _title, url) => { window.location.hash = url.startsWith('#') ? url : ''; },
};
mock.module('../web/js/core/api-client.js', () => ({
  getWorkspaceId: () => workspaceId, getJwt: () => jwt,
  getWorkspaceSlug: () => workspaceSlug,
  setWorkspaceSlug: slug => { workspaceSlug = slug || null; },
  setWorkspaceId: id => { workspaceId = id; }, setBrandId() {},
  apiGet: path => { reads.push({ path, workspaceId }); return fetchTicket(); },
}));
mock.module('../web/js/core/data.js', () => ({ TICKETS, CUSTOMERS }));
mock.module('../web/js/core/toast.js', () => ({ showToast: message => warnings.push(message) }));
mock.module('../web/js/core/auth-client.js', () => ({
  isPlatformAdmin: () => platformAdmin,
  signIn: async () => whoami, rehydrateUser: async () => whoami,
  signOut: () => { jwt = null; workspaceId = null; },
}));
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions() {} }));
mock.module('../web/js/auth/platform-admin.js', () => ({ enterGod() {} }));
mock.module('../web/js/core/bootstrap.js', () => ({
  loadWorkspaceData: async () => { bootCount++; },
  updateOrInsertTicket: row => TICKETS.push({ _uuid: row.id, id: row.display_id }),
}));
mock.module('../web/js/customers/player-lookup.js', () => ({ resetPlayerLookup() {} }));
mock.module('../web/js/core/router.js', () => ({ nav: page => {
  state.setCurrentPage(page); state.setCurrentTicket(null);
  routing.syncRoute(page, null);
} }));
mock.module('../web/js/tickets/detail.js', () => ({ openTicket: id => {
  state.setCurrentPage('tickets'); state.setCurrentTicket(id);
  routing.syncRoute('tickets', id);
} }));
const routing = await import('../web/js/core/url-navigation.js');
const drafts = await import('../web/js/tickets/drafts.js');
const login = await import('../web/js/auth/agent-login.js');

beforeEach(() => {
  routing.suspendUrlRouting();
  saved.clear(); TICKETS.length = CUSTOMERS.length = pushes.length = warnings.length = reads.length = 0;
  workspaceId = ws; jwt = 'test'; reloads = 0; platformAdmin = false; bootCount = 0;
  workspaceSlug = null;
  for (const el of elements.values()) { el.style = {}; el.textContent = el.innerHTML = ''; }
  whoami = { user: { id: 'test', name: 'Test' }, memberships: [ws, otherWs].map(id => ({
    workspace_id: id, workspace_name: 'Example', role_name: 'Admin', suspended: false,
  })) };
  state.setSession({ role: 'Admin', userId: 'test' });
  state.setCurrentPage('dashboard'); state.setCurrentTicket(null); state.setCustomerSelected(null);
  window.location.hash = `#/w/${ws}/dashboard`;
  fetchTicket = async () => ({ ticket: { id: ticketId, display_id: 'TK-55' } });
});

describe('URL navigation', () => {
  it('resolves a platform administrator link through authenticated brand metadata', async () => {
    whoami.user.is_platform_admin = true;
    whoami.memberships = [];
    fetchTicket = async () => ({ brands: [{ id: ws, slug: 'spacecasino', name: 'Space Casino' }] });
    window.location.hash = '#/w/spacecasino/dashboard';
    expect(await login.autoResumeAgent()).toBe(true);
    expect(workspaceId).toBe(ws);
    expect(workspaceSlug).toBe('spacecasino');
    expect(bootCount).toBe(1);
    expect(reads.map(r => r.path)).toEqual(['/api/v1/god/brands']);
    expect(window.location.hash).toBe('#/w/spacecasino/dashboard');
  });

  it('restores a readable link through authenticated workspace membership', async () => {
    workspaceId = null;
    whoami.memberships[0].workspace_slug = 'spacecasino';
    window.location.hash = '#/w/spacecasino/tickets/TK-55';
    expect(await login.autoResumeAgent()).toBe(true);
    expect(workspaceId).toBe(ws);
    expect(state.CURRENT_TICKET).toBe('TK-55');
    expect(reads).toEqual([{ path: '/api/v1/tickets/by-number/TK-55', workspaceId: ws }]);
    expect(window.location.hash).toBe('#/w/spacecasino/tickets/TK-55');
  });

  it('canonicalizes old bookmarks after loading authenticated workspace metadata', async () => {
    whoami.memberships[0].workspace_slug = 'spacecasino';
    window.location.hash = `#/w/${ws}/tickets/${ticketId}`;
    await login.autoResumeAgent();
    expect(window.location.hash).toBe('#/w/spacecasino/tickets/TK-55');
    expect(reads[0].path).toBe(`/api/v1/tickets/${ticketId}`);
  });

  it('does not read another workspace by trusting a readable slug', async () => {
    window.location.hash = '#/w/inaccessible/tickets/TK-55';
    await login.autoResumeAgent();
    expect(bootCount).toBe(0);
    expect(reads).toHaveLength(0);
    expect(window.location.hash).toBe('');
  });

  it('reloads through authentication when a readable link changes workspace', async () => {
    workspaceSlug = 'first';
    window.location.hash = '#/w/second/tickets/TK-55';
    await routing.resumeUrlRouting();
    expect(reloads).toBe(1);
    expect(reads).toHaveLength(0);
  });

  it('opens readable customer numbers from the workspace data', async () => {
    workspaceSlug = 'spacecasino';
    CUSTOMERS.push({ id: 'M25', _uuid: customerId });
    window.location.hash = '#/w/spacecasino/customers/M25';
    await routing.resumeUrlRouting();
    expect(state.CUSTOMER_SELECTED).toBe('M25');
    expect(reads).toHaveLength(0);
    expect(window.location.hash).toBe('#/w/spacecasino/customers/M25');
  });

  it('preserves readable destinations across OAuth', () => {
    const destination = '#/w/spacecasino/customers/M25';
    window.location.hash = destination; routing.saveReturnRoute();
    window.location.hash = '#maestro_session=example'; routing.restoreReturnRoute();
    expect(window.location.hash).toBe(destination);
  });
  it('recovers from an unauthorized link to the normal workspace picker without reading records', async () => {
    window.location.hash = `#/w/66666666-6666-4666-8666-666666666666/tickets/${ticketId}`;
    expect(await login.autoResumeAgent()).toBe(true);
    expect(window.location.hash).toBe('');
    expect(elements.get('login-picker').style.display).toBe('block');
    expect(bootCount).toBe(0);
    expect(reads).toHaveLength(0);
  });

  it('recovers from an inaccessible destination to the sole available workspace', async () => {
    whoami.memberships = [{ workspace_id: otherWs, workspace_name: 'Available', role_name: 'Admin' }];
    window.location.hash = `#/w/${ws}/tickets/${ticketId}`;
    await login.routeAfterAuth(whoami);
    expect(workspaceId).toBe(otherWs);
    expect(bootCount).toBe(1);
    expect(state.CURRENT_PAGE).toBe('dashboard');
    expect(window.location.hash).toBe(`#/w/${otherWs}/dashboard`);
    expect(reads).toHaveLength(0);
  });
  it('keeps same-number drafts separate across workspaces and users', () => {
    drafts.saveDraft('TK-55', 'Workspace A reply', 'reply');
    drafts.saveDraft('TK-55', 'Workspace A note', 'note');
    workspaceId = otherWs;
    expect(drafts.loadDraft('TK-55', 'reply')).toBe('');
    drafts.saveDraft('TK-55', 'Workspace B reply', 'reply');
    workspaceId = ws;
    state.setSession({ role: 'Admin', userId: 'another-user' });
    expect(drafts.loadDraft('TK-55', 'reply')).toBe('');
    state.setSession({ role: 'Admin', userId: 'test' });
    expect(drafts.loadDraft('TK-55', 'reply')).toBe('Workspace A reply');
    drafts.clearAllDrafts('TK-55');
    expect(drafts.loadDraft('TK-55', 'note')).toBe('');
    workspaceId = otherWs;
    expect(drafts.loadDraft('TK-55', 'reply')).toBe('Workspace B reply');
  });

  it('does not guess the ownership of legacy unscoped drafts', () => {
    localStorage.setItem('draft:TK-55:reply', 'Legacy content');
    expect(drafts.loadDraft('TK-55', 'reply')).toBe('');
    drafts.clearAllDrafts('TK-55');
    expect(localStorage.getItem('draft:TK-55:reply')).toBe('Legacy content');
  });
  it('loads a ticket absent from the first page and replaces the initial entry', async () => {
    window.location.hash = `#/w/${ws}/tickets/${ticketId}`;
    await routing.resumeUrlRouting();
    expect(reads).toEqual([{ path: `/api/v1/tickets/${ticketId}`, workspaceId: ws }]);
    expect(state.CURRENT_TICKET).toBe('TK-55');
    expect(pushes).toHaveLength(0);
    routing.syncRoute('tickets', 'TK-55');
    routing.syncRoute('tickets', 'TK-55');
    expect(pushes).toHaveLength(0);
  });

  it('records destination changes but never routine re-renders', async () => {
    await routing.resumeUrlRouting();
    CUSTOMERS.push({ id: 'M25', _uuid: customerId });
    state.setCustomerSelected('M25');
    routing.syncRoute('customers', null);
    routing.syncRoute('customers', null);
    expect(pushes).toEqual([`#/w/${ws}/customers/${customerId}`]);
    window.location.hash = `#/w/${ws}/dashboard`;
    await routing.resumeUrlRouting();
    expect(state.CURRENT_PAGE).toBe('dashboard');
    expect(pushes).toHaveLength(1);
  });

  it('reboots through authentication before reading another workspace', async () => {
    window.location.hash = `#/w/${otherWs}/tickets/${ticketId}`;
    await routing.resumeUrlRouting();
    expect(reloads).toBe(1);
    expect(reads).toHaveLength(0);
    expect(TICKETS).toHaveLength(0);
  });

  it('does not insert or open a late response after navigating away', async () => {
    await routing.resumeUrlRouting();
    let resolve, started;
    const fetched = new Promise(r => { started = r; });
    fetchTicket = () => { started(); return new Promise(r => { resolve = r; }); };
    window.location.hash = `#/w/${ws}/tickets/${ticketId}`;
    const pending = routing.resumeUrlRouting();
    await fetched;
    state.setCurrentPage('customers'); routing.syncRoute('customers', null);
    resolve({ ticket: { id: ticketId, display_id: 'TK-55' } });
    await pending;
    expect(TICKETS).toHaveLength(0);
    expect(state.CURRENT_PAGE).toBe('customers');
    expect(window.location.hash).toBe(`#/w/${ws}/customers`);
  });

  it('does not insert a late response after logout or a workspace change', async () => {
    for (const change of [() => routing.suspendUrlRouting(), () => { workspaceId = otherWs; }]) {
      workspaceId = ws;
      let resolve, started;
      const fetched = new Promise(r => { started = r; });
      fetchTicket = () => { started(); return new Promise(r => { resolve = r; }); };
      window.location.hash = `#/w/${ws}/tickets/${ticketId}`;
      const pending = routing.resumeUrlRouting();
      await fetched; change();
      resolve({ ticket: { id: ticketId, display_id: 'TK-55' } });
      await pending;
      expect(TICKETS).toHaveLength(0);
    }
  });

  it('cancels a pending link when the current sidebar destination is clicked', async () => {
    await routing.resumeUrlRouting();
    let resolve, started;
    const fetched = new Promise(r => { started = r; });
    fetchTicket = () => { started(); return new Promise(r => { resolve = r; }); };
    window.location.hash = `#/w/${ws}/tickets/${ticketId}`;
    const pending = routing.resumeUrlRouting();
    await fetched;
    routing.beginRouteNavigation(); routing.syncRoute('dashboard', null);
    resolve({ ticket: { id: ticketId, display_id: 'TK-55' } });
    await pending;
    expect(TICKETS).toHaveLength(0);
    expect(window.location.hash).toBe(`#/w/${ws}/dashboard`);
  });

  it('handles inaccessible records and forbidden pages without opening them', async () => {
    window.location.hash = `#/w/${ws}/tickets/${ticketId}`;
    fetchTicket = async () => { throw Object.assign(new Error('Not found'), { status: 404 }); };
    await routing.resumeUrlRouting();
    expect(state.CURRENT_TICKET).toBeNull();
    expect(warnings[0]).toBe('This record is unavailable in this workspace.');
    window.location.hash = '#/god';
    state.setSession({ role: 'Platform Admin', userId: 'test' });
    await routing.resumeUrlRouting();
    expect(state.CURRENT_PAGE).toBe('dashboard');
  });

  it('does not break rendering when a legacy view model has an invalid ID', async () => {
    await routing.resumeUrlRouting();
    TICKETS.push({ id: 'TK-55', _uuid: 'legacy-invalid-id' });
    expect(() => routing.syncRoute('tickets', 'TK-55')).not.toThrow();
    expect(pushes).toHaveLength(0);
  });

  it('preserves only validated internal destinations across OAuth, once', () => {
    const destination = `#/w/${ws}/customers/${customerId}`;
    window.location.hash = destination; routing.saveReturnRoute();
    window.location.hash = '#maestro_session=example'; routing.restoreReturnRoute();
    expect(window.location.hash).toBe(destination);
    expect(saved.size).toBe(0);
    window.location.hash = '#maestro_session=example'; routing.saveReturnRoute();
    expect(saved.size).toBe(0);
  });
});
