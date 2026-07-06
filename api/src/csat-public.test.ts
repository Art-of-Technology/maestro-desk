// DB-backed tests for the public CSAT survey endpoints: token expiry (#12),
// token rotation on submit (#12), and rate limiting (#11). Gated behind
// RUN_DB_TESTS like the isolation suite; drives the real Hono app.
//
//   RUN_DB_TESTS=1 DATABASE_URL='…?sslmode=disable' bun test src/csat-public.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('public CSAT survey (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const RUN = Date.now();
  const slug = `csat-${RUN}`;
  let wsId = '';
  let customerId = '';
  let tok = 0;
  let ipSeq = 0;
  const freshIp = () => `198.51.100.${(ipSeq += 1)}`;

  // Seed a resolved ticket with a CSAT token requested `daysAgo` days ago.
  async function seedTicket(daysAgo: number): Promise<string> {
    const token = `tok-${RUN}-${(tok += 1)}`;
    await sql`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key, csat_token, csat_requested_at)
      values (${wsId}, ${'TK-' + RUN + '-' + tok}, 'How did we do?', ${customerId}, 'resolved', 'normal',
              ${token}, now() - (${daysAgo} || ' days')::interval)
    `;
    return token;
  }

  function get(token: string, ip = freshIp()) {
    return app.request(`/api/v1/public/${slug}/csat/${token}`, { headers: { 'x-forwarded-for': ip } });
  }
  function post(token: string, body: unknown, ip = freshIp()) {
    return app.request(`/api/v1/public/${slug}/csat/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const [{ provision_brand }] = await sql<{ provision_brand: string }[]>`
      select provision_brand(${slug}, ${slug}) as provision_brand
    `;
    wsId = provision_brand;
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, email)
      values (${wsId}, ${'M-' + RUN}, 'Pat', ${'pat-' + RUN + '@t.test'}) returning id
    `;
    customerId = cust.id;
  });

  afterAll(async () => {
    if (sql && wsId) await sql`delete from workspaces where id = ${wsId}`;
  });

  it('returns the survey for a fresh token (200)', async () => {
    const token = await seedTicket(1);
    const res = await get(token);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ticket.customer_name).toBe('Pat');
  });

  it('404s for a token older than the TTL (expiry, #12)', async () => {
    const token = await seedTicket(31);
    const res = await get(token);
    expect(res.status).toBe(404);
  });

  it('clears the token on submit so the link stops working (rotation, #12)', async () => {
    const token = await seedTicket(1);
    expect((await post(token, { score: 5 })).status).toBe(200);
    // Token is now nulled → both GET and a second POST 404.
    expect((await get(token)).status).toBe(404);
    expect((await post(token, { score: 4 })).status).toBe(404);
  });

  it('rate-limits the CSAT endpoint (429 past the limit, #11)', async () => {
    const token = await seedTicket(1);
    const ip = freshIp();
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) last = await get(token, ip);
    expect(last!.status).toBe(429);
  });
});
