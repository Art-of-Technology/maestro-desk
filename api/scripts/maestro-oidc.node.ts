// Actual Better Auth HTTP boundaries, synthetic identities, no network or DB.
// Run with the production runtime: node --import tsx --test scripts/maestro-oidc.node.ts
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { bearer } from 'better-auth/plugins';
import { maestroOAuth } from '../src/lib/maestro-oidc.js';

const issuer = 'https://maestro.example.invalid';
const baseURL = 'http://localhost:3333';
const email = 'private-marker@example.invalid';
const keys = [generateKeyPairSync('rsa', { modulusLength: 2048 }), generateKeyPairSync('rsa', { modulusLength: 2048 }), generateKeyPairSync('ed25519')];
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
let fixtureId = 0;

type Scenario = {
  claims?: Record<string, unknown>;
  omit?: string[];
  badSignature?: boolean;
  unsigned?: boolean;
  noIdToken?: boolean;
  existing?: boolean;
  localVerified?: boolean;
  linked?: boolean;
  explicit?: boolean;
  directCallback?: boolean;
  wrongState?: boolean;
  wrongCallbackIssuer?: boolean;
  discovery?: Record<string, unknown>;
  discoveryFailure?: boolean;
  jwksFailure?: boolean;
  tokenFailure?: boolean;
  directIdToken?: boolean;
  internalApi?: boolean;
  refresh?: boolean;
  keyIndex?: number;
};

async function fixture(scenario: Scenario = {}) {
  // Better Auth 1.7 caches JWKS by URL; each outage/rotation fixture needs its own.
  const jwksUrl = issuer + '/jwks/' + ++fixtureId;
  const db: Record<string, any[]> = { user: [], account: [], session: [], verification: [] };
  const now = new Date();
  if (scenario.existing || scenario.explicit || scenario.linked) db.user.push({ id: 'local-user', email, emailVerified: scenario.localVerified !== false, name: 'Local Agent', createdAt: now, updatedAt: now });
  if (scenario.explicit) db.session.push({ id: 'local-session', token: 'synthetic-local-session', userId: 'local-user', createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 60_000) });
  if (scenario.linked) db.account.push({ id: 'local-account', providerId: 'maestro', accountId: 'provider-subject', userId: 'local-user', createdAt: now, updatedAt: now });
  const initialSessions = db.session.length;
  const initialAccounts = db.account.length;
  const paths: string[] = [];
  const logs: unknown[] = [];
  let authorization: URL;
  let issuedToken = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    assert.equal(new URL(url).origin, issuer, 'No cross-origin provider requests');
    paths.push(new URL(url).pathname);
    if (url === issuer + '/.well-known/openid-configuration') {
      if (scenario.discoveryFailure) return new Response('private-marker', { status: 503 });
      return Response.json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: jwksUrl, ...scenario.discovery });
    }
    if (url === jwksUrl) {
      if (scenario.jwksFailure) return new Response('private-marker', { status: 503 });
      const index = scenario.keyIndex ?? 0;
      return Response.json({ keys: [{ ...keys[index].publicKey.export({ format: 'jwk' }), kid: `key-${index}`, alg: index === 2 ? 'EdDSA' : 'RS256', use: 'sig' }] });
    }
    if (url === issuer + '/token') {
      const body = new URLSearchParams(init?.body as URLSearchParams);
      assert.equal(body.get('client_id'), 'expected-client');
      assert.equal(body.get('client_secret'), 'synthetic-secret');
      if (body.get('grant_type') === 'refresh_token') {
        assert.equal(body.get('refresh_token'), 'synthetic-refresh');
        return Response.json({ access_token: 'refreshed-access', token_type: 'Bearer', expires_in: 300 });
      }
      assert.ok(body.get('code_verifier'));
      assert.equal(body.get('redirect_uri'), baseURL + '/api/auth/oauth2/callback/maestro');
      if (scenario.tokenFailure) return Response.json({ error: 'private-marker', access_token: 'synthetic-secret' }, { status: 400 });
      const seconds = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = { iss: issuer, aud: 'expected-client', sub: 'provider-subject', email, email_verified: true, name: null, iat: seconds, exp: seconds + 300, nonce: authorization.searchParams.get('nonce'), ...scenario.claims };
      for (const name of scenario.omit ?? []) delete payload[name];
      const index = scenario.keyIndex ?? 0;
      const input = `${encode({ alg: scenario.unsigned ? 'none' : index === 2 ? 'EdDSA' : 'RS256', kid: `key-${index}` })}.${encode(payload)}`;
      issuedToken = input + '.' + (scenario.unsigned ? '' : scenario.badSignature ? 'invalid-signature' : sign(index === 2 ? null : 'RSA-SHA256', Buffer.from(input), keys[index].privateKey).toString('base64url'));
      return Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 60, ...scenario.noIdToken ? {} : { id_token: issuedToken } });
    }
    throw new Error('Unexpected provider endpoint');
  }) as typeof fetch;

  try {
    const auth = betterAuth({
      database: memoryAdapter(db), baseURL, secret: 'synthetic-proof-secret-longer-than-32-characters',
      logger: { log: (...args) => { logs.push(args); } },
      account: { accountLinking: { enabled: true, trustedProviders: [], requireLocalEmailVerified: true } },
      plugins: [bearer(), maestroOAuth({ issuer, clientId: 'expected-client', clientSecret: 'synthetic-secret', scopes: ['openid', 'profile', 'email'] })],
    });
    const path = scenario.explicit ? '/link-social' : '/sign-in/social';
    const begin = scenario.internalApi ? await auth.api.signInSocial({ body: { provider: 'maestro', callbackURL: baseURL + '/complete' }, asResponse: true }) : await auth.handler(new Request(baseURL + '/api/auth' + path, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL, ...scenario.explicit ? { authorization: 'Bearer synthetic-local-session' } : {} },
      body: JSON.stringify({ provider: 'maestro', callbackURL: baseURL + '/complete', errorCallbackURL: baseURL + '/failed', additionalData: { nonce: 'caller-controlled' }, ...scenario.directIdToken ? { idToken: { token: 'caller-supplied-token' } } : {} }),
    }));
    if (begin.status !== 200) return { beginStatus: begin.status, sessionsAdded: db.session.length - initialSessions, accountsAdded: db.account.length - initialAccounts, paths, logs, beginLocation: begin.headers.get('location') };
    authorization = new URL((await begin.json()).url);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorization.searchParams.get('nonce')!, /^[\w-]{32}$/);
    assert.notEqual(authorization.searchParams.get('nonce'), 'caller-controlled');
    assert.notEqual(authorization.searchParams.get('nonce'), authorization.searchParams.get('code_challenge'));
    if (begin.headers.has('location')) assert.equal(begin.headers.get('location'), authorization.toString());
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    if (scenario.directCallback) callback.pathname = '/api/auth/callback/maestro';
    callback.searchParams.set('code', 'synthetic-code');
    callback.searchParams.set('state', scenario.wrongState ? 'incorrect-state' : authorization.searchParams.get('state')!);
    callback.searchParams.set('iss', scenario.wrongCallbackIssuer ? 'https://wrong.invalid' : issuer);
    const cookie = begin.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const complete = async () => {
      const response = await auth.handler(new Request(callback, { headers: { cookie } }));
      if (callback.pathname.includes('/oauth2/')) {
        assert.equal(response.status, 302);
        const target = new URL(response.headers.get('location')!);
        assert.equal(target.origin, baseURL);
        assert.equal(target.pathname, '/api/auth/callback/maestro');
        assert.equal(target.search, callback.search);
        return auth.handler(new Request(target, { headers: { cookie } }));
      }
      return response;
    };
    const finish = await complete();
    const sessionsAdded = db.session.length - initialSessions;
    const accountsAdded = db.account.length - initialAccounts;
    // Replaying the same state must not mint another session or account.
    await complete();
    assert.equal(db.session.length - initialSessions, sessionsAdded);
    assert.equal(db.account.length - initialAccounts, accountsAdded);
    if (scenario.refresh) {
      assert.equal(sessionsAdded, 1);
      const account = db.account[0];
      account.accessTokenExpiresAt = new Date(0);
      account.refreshToken = 'synthetic-refresh';
      const headers = new Headers({ authorization: 'Bearer ' + db.session.at(-1)!.token });
      const accounts = await auth.api.listUserAccounts({ headers });
      const selected = accounts.find(account => account.providerId === 'maestro')!;
      const result = await auth.api.getAccessToken({ body: { accountId: selected.id, userId: db.user[0].id }, headers });
      assert.equal(result.accessToken, 'refreshed-access');
      assert.equal(db.account[0].accessToken, 'refreshed-access');
      assert.equal(db.account[0].accountId, 'provider-subject');
      await assert.rejects(auth.api.getAccessToken({ body: { accountId: 'another-users-account' }, headers }));
      await auth.api.signOut({ headers });
      await assert.rejects(auth.api.getAccessToken({ body: { accountId: selected.id }, headers }));
    }
    const diagnostic = JSON.stringify(logs);
    assert.ok(!diagnostic.includes(email) && !diagnostic.includes('private-marker') && !diagnostic.includes('synthetic-secret'));
    if (issuedToken) assert.ok(!diagnostic.includes(issuedToken));
    return { beginStatus: begin.status, sessionsAdded, accountsAdded, paths, logs, callbackStatus: finish.status, location: finish.headers.get('location'), user: db.user[0] };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('Maestro signed identity validation across real HTTP sign-in/link boundaries', async t => {
  for (const directCallback of [false, true]) {
    await t.test(`valid sign-in (${directCallback ? 'shared callback' : 'registered callback'})`, async () => {
      const result = await fixture({ directCallback });
      assert.equal(result.sessionsAdded, 1);
      assert.equal(result.location, baseURL + '/complete');
      assert.equal(result.user.name, 'private-marker');
      assert.ok(result.paths.some(path => path.startsWith('/jwks/')));
    });
    for (const [name, scenario] of Object.entries({
      'wrong issuer': { claims: { iss: 'https://wrong.invalid' } },
      'wrong audience': { claims: { aud: 'another-app' } },
      'expired token': { claims: { exp: 1 } },
      'missing expiry': { omit: ['exp'] },
      'missing subject': { omit: ['sub'] },
      'numeric subject': { claims: { sub: 123 } },
      'future not-before': { claims: { nbf: Math.floor(Date.now() / 1000) + 300 } },
      'string expiry': { claims: { exp: '9999999999' } },
      'missing email consent': { omit: ['email'] },
      'wrong nonce': { claims: { nonce: 'another-login' } },
      'missing nonce': { omit: ['nonce'] },
      'invalid signature': { badSignature: true },
      'unsigned token': { unsigned: true },
      'missing id token': { noIdToken: true },
      'string verification': { existing: true, claims: { email_verified: 'false' } },
      'camelCase verification cannot override false': { existing: true, claims: { email_verified: false, emailVerified: true } },
      'false verification link': { existing: true, claims: { email_verified: false } },
      'missing verification link': { existing: true, omit: ['email_verified'] },
      'unverified local link': { existing: true, localVerified: false },
      'wrong callback state': { wrongState: true },
      'signing-key outage': { jwksFailure: true },
      'token exchange error': { tokenFailure: true },
      'future issued-at': { claims: { iat: Math.floor(Date.now() / 1000) + 300 } },
      'missing issued-at': { omit: ['iat'] },
      'untrusted additional audience': { claims: { aud: ['expected-client', 'another-app'] } },
      'wrong authorized party': { claims: { azp: 'another-app' } },
    })) {
      await t.test(`${name} (${directCallback ? 'shared callback' : 'registered callback'})`, async () => {
        const result = await fixture({ ...scenario, directCallback });
        assert.equal(result.sessionsAdded, 0);
        assert.equal(result.accountsAdded, 0);
      });
    }
    await t.test(`verified implicit linking (${directCallback ? 'shared callback' : 'registered callback'})`, async () => {
      const result = await fixture({ existing: true, directCallback });
      assert.equal(result.sessionsAdded, 1);
      assert.equal(result.accountsAdded, 1);
      assert.equal(result.user.id, 'local-user');
    });
    for (const verified of [true, false]) {
      await t.test(`explicit linking, local verified=${verified} (${directCallback ? 'shared callback' : 'registered callback'})`, async () => {
        const result = await fixture({ explicit: true, localVerified: verified, directCallback });
        assert.equal(result.accountsAdded, verified ? 1 : 0);
        assert.equal(result.sessionsAdded, 0);
      });
    }
    await t.test(`explicit linking requires remote verification (${directCallback ? 'shared callback' : 'registered callback'})`, async () => {
      assert.equal((await fixture({ explicit: true, claims: { email_verified: false }, directCallback })).accountsAdded, 0);
    });
  }
  await t.test('already linked identity keeps its local user when remote email is unverified', async () => {
    const result = await fixture({ linked: true, claims: { email_verified: false } });
    assert.equal(result.sessionsAdded, 1);
    assert.equal(result.accountsAdded, 0);
    assert.equal(result.user.id, 'local-user');
  });
  await t.test('new provider signing key is accepted', async () => {
    assert.equal((await fixture({ keyIndex: 1 })).sessionsAdded, 1);
  });
  await t.test('EdDSA signed identity is accepted', async () => {
    assert.equal((await fixture({ keyIndex: 2 })).sessionsAdded, 1);
  });
  await t.test('server-side signInSocial bridge preserves nonce and state cookies', async () => {
    assert.equal((await fixture({ internalApi: true })).sessionsAdded, 1);
  });
  await t.test('existing account refresh selects the local row and respects session revocation', async () => {
    await fixture({ linked: true, refresh: true });
  });
  // Exercise the shared callback directly as well as the registered URL.
  for (const [name, scenario] of Object.entries({
    valid: {},
    'wrong audience': { claims: { aud: 'another-app' } },
    'wrong nonce': { claims: { nonce: 'another-login' } },
    'bad signature': { badSignature: true },
    'unverified remote link': { existing: true, claims: { email_verified: false } },
  })) {
    await t.test(`social callback boundary: ${name}`, async () => {
      assert.equal((await fixture({ ...scenario, directCallback: true })).sessionsAdded, name === 'valid' ? 1 : 0);
    });
  }
  await t.test('wrong callback issuer is rejected before exchange', async () => {
    const result = await fixture({ wrongCallbackIssuer: true });
    assert.equal(result.sessionsAdded, 0);
    assert.ok(!result.paths.includes('/token'));
  });
  for (const explicit of [false, true]) {
    await t.test(`caller-supplied ID token is unsupported (explicit link=${explicit})`, async () => {
      const result = await fixture({ directCallback: true, explicit, directIdToken: true });
      assert.ok(result.beginStatus >= 400);
      assert.equal(result.sessionsAdded, 0);
      assert.equal(result.accountsAdded, 0);
    });
  }
  for (const [name, scenario] of Object.entries({
    'discovery issuer mismatch': { discovery: { issuer: 'https://wrong.invalid' } },
    'foreign token endpoint': { discovery: { token_endpoint: 'https://wrong.invalid/token' } },
    'foreign authorization endpoint': { discovery: { authorization_endpoint: 'https://wrong.invalid/authorize' } },
    'foreign key endpoint': { discovery: { jwks_uri: 'https://wrong.invalid/jwks' } },
    'discovery unavailable': { discoveryFailure: true },
  })) {
    await t.test(name, async () => {
      const result = await fixture(scenario);
      assert.equal(result.sessionsAdded, 0);
      assert.ok(!result.paths.includes('/token'));
      assert.equal(result.beginLocation, null);
    });
  }
});
