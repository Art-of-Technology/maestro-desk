import { Hono } from 'hono';
import { requireAuth, requireAuthOnly } from '../middleware/auth.ts';
import { authorizeChannel, ticketsChannel } from '../lib/pubby.ts';
import { env } from '../lib/env.ts';

// Pubby realtime (Step 5). Two endpoints the SPA needs to connect:
//   GET  /config — non-secret client bootstrap (public app key + ws host)
//   POST /auth   — Pusher-style private-channel auth, scoped to the caller's
//                  own workspace
export const pubby = new Hono();

// Identity-only auth: we don't hand even the public key to anonymous callers,
// but /config needs no workspace context.
pubby.get('/config', requireAuthOnly, (c) =>
  c.json({ key: env.PUBBY_KEY, ws_host: env.PUBBY_WS_HOST }),
);

// requireAuth attaches workspaceId (membership already enforced). We sign ONLY
// the caller's own workspace tickets channel — no cross-tenant subscription.
// The Pubby client POSTs { socket_id, channel_name } as JSON with our bearer +
// X-Workspace-Id headers (set in js/core/realtime.js).
pubby.post('/auth', requireAuth, async (c) => {
  const workspaceId = c.get('workspaceId');
  const body = await c.req.json().catch(() => null);
  const socketId = body?.socket_id;
  const channelName = body?.channel_name;
  if (typeof socketId !== 'string' || typeof channelName !== 'string') {
    return c.json({ error: 'socket_id and channel_name are required' }, 400);
  }
  if (channelName !== ticketsChannel(workspaceId)) {
    return c.json({ error: 'Forbidden channel' }, 403);
  }
  const auth = authorizeChannel(socketId, channelName);
  if (!auth) return c.json({ error: 'Realtime not configured' }, 503);
  return c.json(auth);
});
