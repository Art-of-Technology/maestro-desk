import { describe, expect, it } from 'bun:test';
import { formatRoute, parseRoute, ROUTE_PAGES } from '../web/js/core/route-location.js';

const workspaceId = '69a587ed-4487-427a-a06c-610d98d83149';
const entityId = 'f5f8d68e-e74b-4578-a912-bf27c15b121a';

describe('URL destinations', () => {
  it('round-trips all pages and workspace-scoped records', () => {
    for (const page of ROUTE_PAGES) {
      const route = { workspaceId: page === 'god' ? null : workspaceId, page, entityId: null };
      expect(parseRoute(formatRoute(route))).toEqual(route);
    }
    for (const page of ['customers', 'tickets']) {
      const route = { workspaceId, page, entityId };
      expect(parseRoute(formatRoute(route))).toEqual(route);
    }
  });

  it('supports demo record IDs without mixing them with real workspace IDs', () => {
    expect(parseRoute('#/tickets/TK-001')?.entityId).toBe('TK-001');
    expect(parseRoute(`#/w/${workspaceId}/tickets/TK-001`)).toBeNull();
    expect(parseRoute(`#/w/${workspaceId}/customers/M25`)).toBeNull();
  });

  it('does not interpret authentication fragments or external URLs as routes', () => {
    for (const hash of ['', '#maestro_session=example', '#maestro_error=unavailable',
      'https://example.com', '#//example.com', '#javascript:alert(1)', '#/constructor',
      '#/toString', '#/tickets/%', '#/tickets/..', '#/tickets/a%2Fb',
      '#/tickets/', '#/customers/a/extra', '#/settings/anything',
      '#/w/no-workspace/tickets', `#/w/${workspaceId}/god`, `#/w/${workspaceId}/tickets/a?token=x`]) {
      expect(parseRoute(hash)).toBeNull();
    }
  });

  it('normalizes UUIDs and rejects malformed generated destinations', () => {
    expect(parseRoute(`#/w/${workspaceId.toUpperCase()}/customers/${entityId.toUpperCase()}`))
      .toEqual({ workspaceId, page: 'customers', entityId });
    expect(() => formatRoute({ workspaceId, page: 'tickets', entityId: 'M25' })).toThrow();
  });
});
