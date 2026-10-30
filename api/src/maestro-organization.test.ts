import { afterEach, describe, expect, it } from 'bun:test';
import { env } from './lib/env.js';
import { listUserOrganizations, listUserBrands } from './lib/maestro.js';

const realFetch = globalThis.fetch;
const originalOrganization = env.MAESTRO_ORGANIZATION_ID;
const allowed = { id: '53d2875b-51cd-414d-afe7-27b68fe8b03a', name: 'Staging', slug: 'staging' };
const other = { id: 'b47e805c-c2de-4fe4-9849-4c49969b0d19', name: 'Other', slug: 'other' };
afterEach(() => {
  globalThis.fetch = realFetch;
  env.MAESTRO_ORGANIZATION_ID = originalOrganization;
});

function gateway() {
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    paths.push(path);
    return Response.json(path === '/api/v1/organizations'
      ? { organizations: [allowed, other] }
      : { brands: [{ id: 'test', name: 'Test', organizationId: allowed.id }, { id: 'wrong-org', name: 'Other', organizationId: other.id }] });
  }) as typeof fetch;
  return paths;
}

describe('deployment Maestro organisation restriction', () => {
  it('restricts discovery and never requests brands from other organisations', async () => {
    env.MAESTRO_ORGANIZATION_ID = allowed.id;
    const paths = gateway();
    expect(await listUserOrganizations('synthetic')).toEqual([{ ...allowed, userRole: null }]);
    expect(await listUserBrands('synthetic', [allowed, other])).toEqual([{ id: 'test', name: 'Test', organizationId: allowed.id }]);
    expect(paths).toEqual(['/api/v1/organizations', `/api/v1/organizations/${allowed.id}/brands`]);
  });

  it('does not grant access when the user lacks the configured organisation', async () => {
    env.MAESTRO_ORGANIZATION_ID = allowed.id;
    const paths = gateway();
    expect(await listUserBrands('synthetic', [other])).toEqual([]);
    expect(paths).toEqual([]);
  });

  it('preserves multi-organisation discovery when unset', async () => {
    env.MAESTRO_ORGANIZATION_ID = '';
    gateway();
    expect((await listUserOrganizations('synthetic')).map(o => o.id)).toEqual([allowed.id, other.id]);
    expect((await listUserBrands('synthetic', [allowed, other])).map(b => b.id)).toEqual(['test', 'wrong-org']);
  });
});
