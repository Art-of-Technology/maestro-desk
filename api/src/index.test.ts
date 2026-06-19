// Test for the Bun.serve idleTimeout fix. Triage (and other AI calls) run
// ~12s, but Bun's default idleTimeout is 10s, which closed the socket
// mid-response. index.ts raises it to 30s. This pins the exported config
// value so it can't silently regress to the default.
//
// index.ts starts background workers (setInterval polling) and instantiates
// clients at import time, so we stub those modules before importing it for its
// config object — the test must have no side effects.

import { describe, expect, it, mock } from 'bun:test';
import * as webhooks from './lib/outgoing-webhooks.js';

// Hermetic env so env.ts validation passes without a real api/.env. The DB URL
// is a placeholder — the connection is lazy, so no socket is opened here.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

// No-op the worker-start function so importing index.ts doesn't kick off the
// polling timer; spread the real module so its other exports (e.g.
// dispatchTicketEvent), which the route files import, stay intact.
mock.module('./lib/outgoing-webhooks.js', () => ({ ...webhooks, startWebhookWorker: () => {} }));

// The Bun.serve config now lives in the local dev entry (src/dev.ts);
// src/index.ts is the Vercel entry (`export default app`). dev.ts imports
// index.ts + starts the (mocked) workers, so this still pins the local
// long-request idleTimeout.
const serverConfig = (await import('./dev.js')).default as {
  port: number;
  idleTimeout: number;
  fetch: unknown;
};

describe('Bun.serve config (local dev entry)', () => {
  it('sets idleTimeout to 30s so ~12s AI requests are not dropped', () => {
    expect(serverConfig.idleTimeout).toBe(30);
  });

  it('keeps idleTimeout above the ~12s worst-case triage duration', () => {
    // Regression guard: anything <= the old 10s default would drop triage.
    expect(serverConfig.idleTimeout).toBeGreaterThan(12);
  });

  it('still exports a fetch handler and a port', () => {
    expect(typeof serverConfig.fetch).toBe('function');
    expect(serverConfig.port).toBeGreaterThan(0);
  });
});
