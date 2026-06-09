import { PubbyServer } from '@getpubby/sdk/server';
import { env } from './env.ts';

// Pubby realtime (migration — Step 5). Pusher-compatible push so the SPA gets
// live ticket/message updates instead of (only) polling. The server triggers a
// tiny "ticket.changed" signal on a private, workspace-scoped channel; the SPA
// reacts by running its existing cursor-sync fetch.
//
// Lazy + best-effort, mirroring lib/r2.ts: if PUBBY_* is unset the helpers
// no-op (logged once) and the app keeps working on its fallback poll — so
// realtime is purely additive and never blocks a request or a mutation.

let _server: PubbyServer | null = null;
let _warned = false;

function getServer(): PubbyServer | null {
  const { PUBBY_APP_ID, PUBBY_KEY, PUBBY_SECRET } = env;
  if (!PUBBY_APP_ID || !PUBBY_KEY || !PUBBY_SECRET) {
    if (!_warned) {
      console.warn('[pubby] not configured (PUBBY_APP_ID/KEY/SECRET) — realtime disabled; SPA falls back to polling');
      _warned = true;
    }
    return null;
  }
  if (!_server) {
    _server = new PubbyServer({
      appId: PUBBY_APP_ID,
      key: PUBBY_KEY,
      secret: PUBBY_SECRET,
      ...(env.PUBBY_API_HOST ? { apiHost: env.PUBBY_API_HOST } : {}),
    });
  }
  return _server;
}

export function isPubbyConfigured(): boolean {
  return Boolean(env.PUBBY_APP_ID && env.PUBBY_KEY && env.PUBBY_SECRET);
}

// Private channel carrying ticket/message change signals for one workspace.
// Private (not public) so a client can only subscribe after the auth endpoint
// confirms workspace membership — no cross-tenant subscription.
export function ticketsChannel(workspaceId: string): string {
  return `private-ws-${workspaceId}-tickets`;
}

// Best-effort publish of a "this ticket changed, re-sync" signal. Never throws
// into the request path — a realtime hiccup must not fail the mutation that
// already committed.
export async function publishTicketChanged(workspaceId: string, ticketId: string): Promise<void> {
  const server = getServer();
  if (!server) return;
  try {
    await server.trigger(ticketsChannel(workspaceId), 'ticket.changed', { id: ticketId });
  } catch (err) {
    console.warn('[pubby] publishTicketChanged failed:', err instanceof Error ? err.message : err);
  }
}

// Sign a private-channel subscription (Pusher-style). Returns null when Pubby
// is unconfigured so the route can 503 cleanly. The CALLER must first verify
// the channel belongs to the caller's workspace.
export function authorizeChannel(socketId: string, channel: string): { auth: string } | null {
  const server = getServer();
  if (!server) return null;
  return server.authenticatePrivateChannel(socketId, channel);
}
