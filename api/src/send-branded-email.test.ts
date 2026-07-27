// sendBrandedEmail — branded From resolution with the platform-sender safety
// net. Pure classifier tests always run; the send/fallback paths are
// DB-backed (getOutboundFrom queries workspace_email_domains) → RUN_DB_TESTS.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const { isSenderSignatureError } = await import('./lib/send-branded-email.js');
const { PostmarkSendError } = await import('./lib/postmark-outbound.js');

describe('isSenderSignatureError', () => {
  it('matches Postmark sender-signature codes 400 and 401 only', () => {
    expect(isSenderSignatureError(new PostmarkSendError('x', 400, 422))).toBe(true);
    expect(isSenderSignatureError(new PostmarkSendError('x', 401, 422))).toBe(true);
    expect(isSenderSignatureError(new PostmarkSendError('x', 406, 200))).toBe(false); // inactive recipient
    expect(isSenderSignatureError(new PostmarkSendError('x', 300, 422))).toBe(false); // invalid email request
    expect(isSenderSignatureError(new Error('x'))).toBe(false);
    expect(isSenderSignatureError(undefined)).toBe(false);
  });
});

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('sendBrandedEmail (DB-backed)', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let sendBrandedEmail: typeof import('./lib/send-branded-email.js').sendBrandedEmail;
  let envMod: typeof import('./lib/env.js');

  const RUN = Date.now();
  const ctx = {} as Record<string, string>;

  const realFetch = globalThis.fetch;
  // Per-test controls for the Postmark /email stub.
  let emailCalls: Array<{ From: string; To: string }> = [];
  let rejectFroms: Set<string> = new Set(); // From addresses to reject with ErrorCode 400
  let rejectCode = 400;

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    ({ sendBrandedEmail } = await import('./lib/send-branded-email.js'));
    envMod = await import('./lib/env.js');

    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`
      select provision_brand(${'sbe-' + RUN}, ${'sbe-' + RUN}) as provision_brand`;
    ctx.ws = ws;
  }, 30000);

  beforeEach(() => {
    emailCalls = [];
    rejectFroms = new Set();
    rejectCode = 400;
    const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.startsWith('https://api.postmarkapp.com/email')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        // Postmark's From may be `Name <addr>`; extract the address.
        const m = String(body.From).match(/<([^>]+)>/);
        const fromAddr = m ? m[1] : String(body.From);
        emailCalls.push({ From: fromAddr, To: body.To });
        if (rejectFroms.has(fromAddr)) {
          return new Response(
            JSON.stringify({ ErrorCode: rejectCode, Message: `The 'From' address you supplied (${fromAddr}) is not a Sender Signature on your account.` }),
            { status: 422, headers: { 'content-type': 'application/json' } });
        }
        return new Response(
          JSON.stringify({ MessageID: 'pm-' + emailCalls.length, SubmittedAt: '2026-01-01T00:00:00Z', To: body.To, ErrorCode: 0, Message: 'OK' }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    };
    // Bun's `typeof fetch` also carries `preconnect`; borrow the real one so
    // the stub satisfies the type without an `any` cast.
    globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await sql`delete from workspace_email_domains where workspace_id = ${ctx.ws}`;
  });

  async function addVerifiedDomain(domain: string) {
    await sql`
      insert into workspace_email_domains (workspace_id, domain, verified_at)
      values (${ctx.ws}, ${domain}, now())`;
  }

  const baseArgs = () => ({
    workspaceId: ctx.ws,
    fallbackFromName: 'SBE Test',
    to: 'customer@t.test',
    subject: 'hello',
    textBody: 'body',
  });

  it('sends from the branded domain when one is verified', async () => {
    await addVerifiedDomain(`sbe-a-${RUN}.test`);
    const res = await sendBrandedEmail(baseArgs());
    expect(res.usedFallbackFrom).toBe(false);
    expect(res.fromEmail).toBe(`support@sbe-a-${RUN}.test`);
    expect(emailCalls).toHaveLength(1);
  });

  it('sends from the platform sender when no domain is verified', async () => {
    const res = await sendBrandedEmail(baseArgs());
    expect(res.usedFallbackFrom).toBe(false);
    expect(res.fromEmail).toBe(envMod.env.POSTMARK_OUTBOUND_FROM);
    expect(emailCalls).toHaveLength(1);
  });

  it('retries once from the platform sender when the branded From is rejected (code 400)', async () => {
    const domain = `sbe-b-${RUN}.test`;
    await addVerifiedDomain(domain);
    rejectFroms.add(`support@${domain}`);
    const res = await sendBrandedEmail(baseArgs());
    expect(emailCalls).toHaveLength(2);
    expect(emailCalls[0].From).toBe(`support@${domain}`);
    expect(emailCalls[1].From).toBe(envMod.env.POSTMARK_OUTBOUND_FROM);
    expect(res.usedFallbackFrom).toBe(true);
    expect(res.fromEmail).toBe(envMod.env.POSTMARK_OUTBOUND_FROM);
  });

  it('retries on code 401 (signature not confirmed) too', async () => {
    const domain = `sbe-c-${RUN}.test`;
    await addVerifiedDomain(domain);
    rejectFroms.add(`support@${domain}`);
    rejectCode = 401;
    const res = await sendBrandedEmail(baseArgs());
    expect(emailCalls).toHaveLength(2);
    expect(res.usedFallbackFrom).toBe(true);
  });

  it('does NOT retry on non-signature errors (code 406 inactive recipient)', async () => {
    const domain = `sbe-d-${RUN}.test`;
    await addVerifiedDomain(domain);
    rejectFroms.add(`support@${domain}`);
    rejectCode = 406;
    let threw: unknown = null;
    try { await sendBrandedEmail(baseArgs()); } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(PostmarkSendError);
    expect((threw as InstanceType<typeof PostmarkSendError>).code).toBe(406);
    expect(emailCalls).toHaveLength(1);
  });

  it('does NOT retry when the platform sender itself is rejected', async () => {
    rejectFroms.add(envMod.env.POSTMARK_OUTBOUND_FROM);
    let threw: unknown = null;
    try { await sendBrandedEmail(baseArgs()); } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(PostmarkSendError);
    expect(emailCalls).toHaveLength(1);
  });

  it('rethrows (after alerting) when the fallback resend is ALSO rejected', async () => {
    const domain = `sbe-e-${RUN}.test`;
    await addVerifiedDomain(domain);
    rejectFroms.add(`support@${domain}`);
    rejectFroms.add(envMod.env.POSTMARK_OUTBOUND_FROM);
    let threw: unknown = null;
    try { await sendBrandedEmail(baseArgs()); } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(PostmarkSendError);
    // Exactly two attempts: branded, then the platform retry — no loop.
    expect(emailCalls).toHaveLength(2);
    expect(emailCalls[1].From).toBe(envMod.env.POSTMARK_OUTBOUND_FROM);
  });
});
