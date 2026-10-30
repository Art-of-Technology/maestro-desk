import { afterEach, describe, expect, it } from 'bun:test';
import { env } from './lib/env.js';
import { listUserOrganizations, listUserBrands, workerMaestroConfigured, workerFetch } from './lib/maestro.js';

const realFetch = globalThis.fetch;
const originalOrganization = env.MAESTRO_ORGANIZATION_ID;
const originalBrand = env.MAESTRO_ALLOWED_BRAND_ID;
const originalWorkerToken = env.MAESTRO_API_TOKEN;
const allowed = { id: '53d2875b-51cd-414d-afe7-27b68fe8b03a', name: 'Staging', slug: 'staging' };
const other = { id: 'b47e805c-c2de-4fe4-9849-4c49969b0d19', name: 'Other', slug: 'other' };
afterEach(() => {
  globalThis.fetch = realFetch;
  env.MAESTRO_ORGANIZATION_ID = originalOrganization;
  env.MAESTRO_ALLOWED_BRAND_ID = originalBrand;
  env.MAESTRO_API_TOKEN = originalWorkerToken;
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
  it('limits workspace candidates to the configured brand and fails closed when absent', async () => {
    env.MAESTRO_ORGANIZATION_ID = allowed.id;
    env.MAESTRO_ALLOWED_BRAND_ID = 'test';
    gateway();
    expect((await listUserBrands('synthetic', [allowed])).map(b => b.id)).toEqual(['test']);
    env.MAESTRO_ALLOWED_BRAND_ID = 'not-accessible';
    expect(await listUserBrands('synthetic', [allowed])).toEqual([]);
  });

  it('cannot fetch player data without a worker token', () => {
    env.MAESTRO_API_TOKEN = '';
    const paths = gateway();
    expect(workerMaestroConfigured()).toBe(false);
    expect(() => workerFetch('/api/v1/proxy/member/lookup')).toThrow('MAESTRO_API_TOKEN is not configured');
    expect(paths).toEqual([]);
  });
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
