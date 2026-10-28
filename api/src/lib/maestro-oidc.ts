import { APIError, createAuthEndpoint, createAuthMiddleware, getOAuthState } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthorizationURL, refreshAccessToken, validateAuthorizationCode, validateToken, type OAuthProvider } from 'better-auth/oauth2';
import { z } from 'zod';

export const MAESTRO_PROVIDER_ID = 'maestro';

const identityClaims = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  name: z.string().nullable().optional(),
  picture: z.string().url().nullable().optional(),
  exp: z.number().int(),
  iat: z.number().int().nonnegative(),
  nonce: z.string().optional(),
  azp: z.string().optional(),
});

export function maestroOAuth(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}) {
  const { issuer, clientId, clientSecret, scopes } = options;
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  // Current Maestro endpoints share the HTTPS issuer origin. A changed host
  // requires a reviewed provider contract, not forwarding codes/secrets to it.
  const endpoint = z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === new URL(issuer).origin
      && !url.username && !url.password && !url.hash;
  });
  const discoverySchema = z.object({
    issuer: z.literal(issuer),
    authorization_endpoint: endpoint,
    token_endpoint: endpoint,
    jwks_uri: endpoint,
  });
  async function discover() {
    const response = await fetch(discoveryUrl, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Maestro discovery unavailable');
    return discoverySchema.parse(await response.json());
  }

  const provider: OAuthProvider<{ sub: string }> = {
    id: MAESTRO_PROVIDER_ID,
    name: 'Maestro',
    issuer,
    // Keep the URL already registered with Maestro; the endpoint below forwards
    // to Better Auth's shared callback without changing the token redirect URI.
    callbackPath: '/oauth2/callback/maestro',
    requiresIdTokenNonce: true,
    accountSubject: ({ profile }) => profile.sub,
    async createAuthorizationURL(data) {
      try {
        const metadata = await discover();
        return await createAuthorizationURL({
          ...data, id: MAESTRO_PROVIDER_ID, options: { clientId, clientSecret },
          authorizationEndpoint: metadata.authorization_endpoint,
          scopes, nonce: data.idTokenNonce,
        });
      } catch {
        throw new APIError('BAD_REQUEST', { message: 'Maestro sign-in is unavailable. Please try again.' });
      }
    },
    async validateAuthorizationCode(data) {
      try {
        const metadata = await discover();
        // Preserve the app's registered client_secret_post exchange.
        return await validateAuthorizationCode({ ...data, options: { clientId, clientSecret }, tokenEndpoint: metadata.token_endpoint, authentication: 'post' });
      } catch {
        throw new Error('Maestro token exchange failed');
      }
    },
    async refreshAccessToken(refreshToken) {
      try {
        const metadata = await discover();
        return await refreshAccessToken({ refreshToken, options: { clientId, clientSecret }, tokenEndpoint: metadata.token_endpoint, authentication: 'post' });
      } catch {
        throw new Error('Maestro token refresh failed');
      }
    },
    async getUserInfo(tokens) {
      try {
        if (!tokens.idToken) return null;
        const metadata = await discover();
        const { payload } = await validateToken(tokens.idToken, metadata.jwks_uri, {
          issuer, audience: clientId, algorithms: ['RS256', 'EdDSA'],
        });
        const claims = identityClaims.parse(payload);
        if (claims.iat > Math.floor(Date.now() / 1000) + 60 || claims.exp <= claims.iat
          || (Array.isArray(payload.aud) && payload.aud.some(aud => aud !== clientId))
          || (claims.azp !== undefined && claims.azp !== clientId)) return null;
        const state = await getOAuthState();
        // Account-info can read a stored, signed token outside a callback.
        if (state && (!tokens.expectedIdTokenNonce || claims.nonce !== tokens.expectedIdTokenNonce)) return null;
        if (state?.link && claims.email_verified !== true) return null;
        return {
          data: { sub: claims.sub },
          user: {
            email: claims.email,
            emailVerified: claims.email_verified === true,
            name: claims.name?.trim() || claims.email.split('@')[0],
            image: claims.picture ?? undefined,
          },
        };
      } catch {
        return null;
      }
    },
  };

  return {
    id: 'maestro-oidc',
    init: ctx => ({ context: { socialProviders: [provider, ...ctx.socialProviders] } }),
    hooks: { after: [{
      matcher: ctx => ctx.path === '/link-social' && ctx.body?.provider === MAESTRO_PROVIDER_ID,
      handler: createAuthMiddleware(async ctx => {
        if (ctx.context.session?.user.emailVerified !== true) {
          ctx.context.responseHeaders?.delete('location');
          throw new APIError('BAD_REQUEST', { message: 'Verify your email before linking Maestro.' });
        }
      }),
    }] },
    endpoints: {
      maestroCallback: createAuthEndpoint('/oauth2/callback/maestro', { method: 'GET' }, async ctx => {
        const query = new URL(ctx.request!.url).search;
        throw ctx.redirect(`${ctx.context.baseURL}/callback/maestro${query}`);
      }),
    },
  } satisfies BetterAuthPlugin;
}
