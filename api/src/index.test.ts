// Test for the Bun.serve idleTimeout fix. Triage (and other AI calls) run
// ~12s, but Bun's default idleTimeout is 10s, which closed the socket
// mid-response. index.ts raises it to 30s. This pins the exported config
// value so it can't silently regress to the default.
//
// index.ts starts background workers (setInterval polling Supabase) and
// instantiates clients at import time, so we stub those modules before
// importing it for its config object — the test must have no side effects.

import { describe, expect, it, mock } from 'bun:test';
import * as webhooks from './lib/outgoing-webhooks.ts';
import * as csat from './lib/csat-survey.ts';

// Hermetic env so env.ts validation passes without a real api/.env.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ||= 'anon-key-placeholder-0123456789';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'service-key-placeholder-0123456789';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

// No-op only the worker-start functions so importing index.ts doesn't kick
// off polling timers; spread the real modules so their other exports (e.g.
// dispatchTicketEvent), which the route files import, stay intact.
mock.module('./lib/outgoing-webhooks.ts', () => ({ ...webhooks, startWebhookWorker: () => {} }));
mock.module('./lib/csat-survey.ts', () => ({ ...csat, startCsatReminderWorker: () => {} }));

const serverConfig = (await import('./index.ts')).default as {
  port: number;
  idleTimeout: number;
  fetch: unknown;
};

describe('Bun.serve config', () => {
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
