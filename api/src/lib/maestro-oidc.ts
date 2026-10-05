import { createHash } from 'node:crypto';
import { APIError, createAuthMiddleware, getOAuthState } from 'better-auth/api';
import { genericOAuth } from 'better-auth/plugins';
import { validateAuthorizationCode, validateToken } from 'better-auth/oauth2';
import { z } from 'zod';

export const MAESTRO_PROVIDER_ID = 'maestro';

// Reuse Better Auth's one-use state and random PKCE verifier; no second nonce
// store/cookie. Domain separation keeps the nonce distinct from the PKCE hash.
function nonceFor(codeVerifier: string): string {
  return createHash('sha256').update(`respovia-maestro-nonce:${codeVerifier}`).digest('base64url');
}

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

  const plugin = genericOAuth({ config: [{
    providerId: MAESTRO_PROVIDER_ID,
    issuer,
    discoveryUrl,
    clientId,
    clientSecret,
    scopes,
    pkce: true,
    // Preserve the existing client_secret_post exchange. Discovery's list of
    // supported methods does not establish this app's registered client type.
    authentication: 'post',
    async getToken(data) {
      try {
        const metadata = await discover();
        return await validateAuthorizationCode({ ...data, options: { clientId, clientSecret }, tokenEndpoint: metadata.token_endpoint, authentication: 'post' });
      } catch {
        // Provider responses can contain credentials or claims. Never forward
        // their raw error bodies into Better Auth's diagnostics.
        throw new Error('Maestro token exchange failed');
      }
    },
    async getUserInfo(tokens) {
      try {
        if (!tokens.idToken) return null;
        const metadata = await discover();
        const { payload, protectedHeader } = await validateToken(tokens.idToken, metadata.jwks_uri, { issuer, audience: clientId });
        if (!['RS256', 'EdDSA'].includes(protectedHeader.alg)) return null;
        const claims = identityClaims.parse(payload);
        // jwtVerify checks exp/nbf when present; require exp/iat too. Reject
        // untrusted additional audiences and a mismatched authorized party.
        if (claims.iat > Math.floor(Date.now() / 1000) + 60 || claims.exp <= claims.iat
          || (Array.isArray(payload.aud) && payload.aud.some(aud => aud !== clientId))
          || (claims.azp !== undefined && claims.azp !== clientId)) return null;
        const state = await getOAuthState();
        // Account-info may read a stored, still-valid token outside a callback.
        // Both callback families parse Better Auth state before calling here.
        if (state && claims.nonce !== nonceFor(state.codeVerifier)) return null;
        if (state?.link && claims.email_verified !== true) return null;
        return {
          id: claims.sub,
          email: claims.email,
          emailVerified: claims.email_verified === true,
          name: claims.name?.trim() || claims.email.split('@')[0],
          image: claims.picture ?? undefined,
        };
      } catch {
        return null; // Existing OAuth error bridge gives a safe sign-in error.
      }
    },
  }] });

  return {
    ...plugin,
    hooks: { after: [{
      matcher: (ctx: { path?: string; body?: Record<string, unknown> }) =>
        ['/sign-in/oauth2', '/oauth2/link', '/sign-in/social', '/link-social'].includes(ctx.path ?? '')
        && (ctx.body?.providerId === MAESTRO_PROVIDER_ID || ctx.body?.provider === MAESTRO_PROVIDER_ID),
      handler: createAuthMiddleware(async ctx => {
        const result = ctx.context.returned;
        if (!result || typeof result !== 'object' || !('url' in result) || typeof result.url !== 'string') return;
        try {
          const state = await getOAuthState();
          if (!state?.codeVerifier) throw new Error('Missing OAuth state');
          if (state.link && ctx.context.session?.user.emailVerified !== true) throw new Error('Unverified local identity');
          const metadata = await discover();
          const url = new URL(result.url);
          const expected = new URL(metadata.authorization_endpoint);
          if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new Error('Invalid authorization endpoint');
          url.searchParams.set('nonce', nonceFor(state.codeVerifier));
          if (ctx.context.responseHeaders?.has('location')) ctx.setHeader('location', url.toString());
          return ctx.json({ ...result, url: url.toString() });
        } catch {
          // Remove an existing redirect before reporting validation failure.
          ctx.context.responseHeaders?.delete('location');
          throw new APIError('BAD_REQUEST', { message: 'Maestro sign-in is unavailable. Please try again.' });
        }
      }),
    }] },
  };
}
