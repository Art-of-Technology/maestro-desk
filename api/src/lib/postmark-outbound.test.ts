// Tests for the outbound Postmark send, focused on the Reply-To fix:
// Postmark's Email API rejects `Reply-To` inside the Headers array with
// HTTP 422 "Header 'Reply-To' not allowed" — it must be the dedicated
// top-level `ReplyTo` field. These tests pin that behaviour so a future
// refactor can't quietly move it back into Headers.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

// env.ts validates process.env at import time and several vars are required
// (no defaults). Provide hermetic fallbacks so the suite runs without a real
// api/.env; `||=` keeps any real values when they are present.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ||= 'anon-key-placeholder-0123456789';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'service-key-placeholder-0123456789';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';
// Force these two non-empty so isPostmarkConfigured() is true and the send
// path runs regardless of the ambient environment.
process.env.POSTMARK_SERVER_TOKEN = 'test-server-token';
process.env.POSTMARK_OUTBOUND_FROM = 'support@maestro.test';

const { sendEmail } = await import('./postmark-outbound.ts');

type CapturedRequest = { url: string; body: Record<string, unknown> };

const realFetch = globalThis.fetch;
let captured: CapturedRequest | null;

beforeEach(() => {
  captured = null;
  // Stub fetch to capture the request Postmark would receive and return a
  // success envelope (ErrorCode 0 is Postmark's success marker).
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')),
    };
    return new Response(
      JSON.stringify({
        MessageID: 'pm-message-id',
        SubmittedAt: '2026-01-01T00:00:00.000Z',
        To: 'customer@acme.test',
        ErrorCode: 0,
        Message: 'OK',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const baseArgs = {
  to: 'customer@acme.test',
  subject: 'Re: Checkout failing',
  textBody: 'Thanks for reaching out.',
  fromEmail: 'support@maestro.test',
  fromName: 'Maestro Desk',
};

function headerNames(body: Record<string, unknown>): string[] {
  const headers = (body.Headers ?? []) as Array<{ Name: string }>;
  return headers.map((h) => h.Name.toLowerCase());
}

describe('sendEmail Reply-To handling', () => {
  it('sends Reply-To as a top-level ReplyTo field, never in Headers', async () => {
    await sendEmail({ ...baseArgs, replyTo: 'reply@inbound.postmarkapp.com' });

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://api.postmarkapp.com/email');
    // The whole point of the fix: top-level field, not a header entry.
    expect(captured!.body.ReplyTo).toBe('reply@inbound.postmarkapp.com');
    expect(headerNames(captured!.body)).not.toContain('reply-to');
  });

  it('omits ReplyTo entirely when no replyTo is given', async () => {
    await sendEmail({ ...baseArgs, replyTo: null });

    expect(captured!.body.ReplyTo).toBeUndefined();
    expect(headerNames(captured!.body)).not.toContain('reply-to');
  });

  it('still sets In-Reply-To / References as Headers (those are not reserved)', async () => {
    await sendEmail({
      ...baseArgs,
      replyTo: 'reply@inbound.postmarkapp.com',
      inReplyTo: '<original@acme.test>',
    });

    const names = headerNames(captured!.body);
    expect(names).toContain('in-reply-to');
    expect(names).toContain('references');
    expect(names).toContain('message-id');
    // Reply-To must remain out of Headers even alongside other threading headers.
    expect(names).not.toContain('reply-to');
  });
});
