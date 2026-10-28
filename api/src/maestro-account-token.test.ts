import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { auth } from './lib/auth.js';
import { env } from './lib/env.js';
import { getUserAccessToken } from './lib/maestro.js';

const originalClient = { id: env.MAESTRO_CLIENT_ID, secret: env.MAESTRO_CLIENT_SECRET };
const accounts = spyOn(auth.api, 'listUserAccounts');
const token = spyOn(auth.api, 'getAccessToken');

afterEach(() => {
  accounts.mockRestore();
  token.mockRestore();
  env.MAESTRO_CLIENT_ID = originalClient.id;
  env.MAESTRO_CLIENT_SECRET = originalClient.secret;
});

describe('Maestro gateway account selection', () => {
  it('selects the session user’s Maestro row among multiple providers', async () => {
    env.MAESTRO_CLIENT_ID = 'synthetic-client';
    env.MAESTRO_CLIENT_SECRET = 'synthetic-secret';
    const now = new Date();
    accounts.mockResolvedValue(['credential', 'maestro'].map(providerId => ({
      id: providerId + '-row', providerId, accountId: providerId + '-subject',
      userId: 'session-user', createdAt: now, updatedAt: now, scopes: [],
    })));
    token.mockResolvedValue({ accessToken: 'synthetic-access', scopes: [], accessTokenExpiresAt: undefined, idToken: undefined });
    const headers = new Headers({ authorization: 'Bearer synthetic-session' });
    expect(await getUserAccessToken('session-user', headers)).toBe('synthetic-access');
    expect(accounts).toHaveBeenCalledWith({ headers });
    expect(token).toHaveBeenCalledWith({ body: { accountId: 'maestro-row', userId: 'session-user' }, headers });
  });
});
