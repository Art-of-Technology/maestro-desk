// Audit-chain verification — DB-backed (RUN_DB_TESTS). Covers both the new
// incremental verifier (checkpoint bootstrap/advance, new-region + boundary
// tamper detection, the documented historical-miss) and the full read-only
// verifier (catches historical alter + seq gap). Tamper simulation bypasses the
// append-only triggers via session_replication_role = replica (a superuser /
// direct-DB action — exactly the threat model the verifier backstops).
//
// Run locally:
//   docker run -d -e POSTGRES_PASSWORD=p -e POSTGRES_USER=u -e POSTGRES_DB=test -p 5432:5432 postgres:17
//   DATABASE_URL='postgresql://u:p@localhost:5432/test?sslmode=disable' bun run migrate
//   RUN_DB_TESTS=1 DATABASE_URL='…?sslmode=disable' bun test src/audit-verify.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('audit-chain verification (DB-backed)', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let verifyAuditChains: typeof import('./lib/audit-verify.js').verifyAuditChains;
  let verifyAuditChainsFull: typeof import('./lib/audit-verify.js').verifyAuditChainsFull;

  const RUN = Date.now();
  const wsIds: string[] = [];

  type VerifyRow = { workspace_id: string; ok: boolean; first_bad_seq: string | null; first_bad_id: string | null };

  async function provisionWs(tag: string): Promise<string> {
    const slug = `av-${tag}-${RUN}`;
    const [{ provision_brand: id }] = await sql<{ provision_brand: string }[]>`
      select provision_brand(${slug}, ${slug}) as provision_brand
    `;
    wsIds.push(id);
    return id;
  }
  // Insert n audit rows (trigger builds the chain). Returns nothing; use headSeq.
  async function addEvents(wsId: string, n: number, action = 'test.event'): Promise<void> {
    for (let i = 0; i < n; i++) {
      await sql`insert into audit_events (workspace_id, action, metadata)
                values (${wsId}, ${action}, ${sql.json({ i })})`;
    }
  }
  async function headSeq(wsId: string): Promise<number> {
    const [r] = await sql<{ m: number | null }[]>`select max(seq)::int as m from audit_events where workspace_id = ${wsId}`;
    return r.m ?? 0;
  }
  async function checkpoint(wsId: string): Promise<{ last_seq: number } | null> {
    const [r] = await sql<{ last_seq: number }[]>`select last_seq::int as last_seq from audit_verify_checkpoints where workspace_id = ${wsId}`;
    return r ?? null;
  }
  const incr = (wsId: string) => sql<VerifyRow[]>`select * from audit_events_verify_incremental(${wsId})`;
  const full = (wsId: string) => sql<VerifyRow[]>`select * from audit_events_verify(${wsId})`;

  // Mutate an "immutable" audit row with the append-only triggers bypassed.
  async function tamperUpdate(wsId: string, seq: number, set: (t: any) => Promise<unknown>): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await set(tx);
      void wsId; void seq;
    });
  }

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    ({ verifyAuditChains, verifyAuditChainsFull } = await import('./lib/audit-verify.js'));
  });

  afterAll(async () => {
    if (!sql) return;
    for (const id of wsIds) await sql`delete from workspaces where id = ${id}`;
  });

  it('bootstraps from genesis and advances the checkpoint', async () => {
    const ws = await provisionWs('boot');
    await addEvents(ws, 3);
    const rows = await incr(ws);
    const row = rows.find((r) => r.workspace_id === ws)!;
    expect(row.ok).toBe(true);
    const head1 = await headSeq(ws);
    expect((await checkpoint(ws))?.last_seq).toBe(head1);

    await addEvents(ws, 2);
    const rows2 = await incr(ws);
    expect(rows2.find((r) => r.workspace_id === ws)!.ok).toBe(true);
    const head2 = await headSeq(ws);
    expect(head2).toBe(head1 + 2);
    expect((await checkpoint(ws))?.last_seq).toBe(head2);        // advanced
  });

  it('detects a tamper in the new region and does not advance the checkpoint', async () => {
    const ws = await provisionWs('new');
    await addEvents(ws, 3);
    await incr(ws);
    const cp = (await checkpoint(ws))!.last_seq;

    await addEvents(ws, 3);                                       // cp+1 .. cp+3
    const target = cp + 2;
    const [{ id: badId }] = await sql<{ id: string }[]>`select id from audit_events where workspace_id = ${ws} and seq = ${target}`;
    await tamperUpdate(ws, target, (tx) =>
      tx`update audit_events set metadata = ${tx.json({ tampered: true })} where id = ${badId}`);

    const rows = await incr(ws);
    const row = rows.find((r) => r.workspace_id === ws)!;
    expect(row.ok).toBe(false);
    expect(Number(row.first_bad_seq)).toBe(target);
    expect((await checkpoint(ws))?.last_seq).toBe(cp);           // NOT advanced
  });

  it('detects a broken prev-link at the checkpoint boundary', async () => {
    const ws = await provisionWs('boundary');
    await addEvents(ws, 3);
    await incr(ws);
    const cp = (await checkpoint(ws))!.last_seq;

    await addEvents(ws, 2);                                       // cp+1, cp+2
    const boundary = cp + 1;
    await tamperUpdate(ws, boundary, (tx) =>
      tx`update audit_events set prev_hash = decode('00','hex') where workspace_id = ${ws} and seq = ${boundary}`);

    const rows = await incr(ws);
    const row = rows.find((r) => r.workspace_id === ws)!;
    expect(row.ok).toBe(false);
    expect(Number(row.first_bad_seq)).toBe(boundary);
  });

  it('MISSES a historical tamper below the checkpoint (incremental) but the full verifier catches it', async () => {
    const ws = await provisionWs('hist');
    await addEvents(ws, 5);
    await incr(ws);                                              // cp at head

    // Alter an OLD row (below the checkpoint) without cascading forward.
    await tamperUpdate(ws, 2, (tx) =>
      tx`update audit_events set metadata = ${tx.json({ hacked: true })} where workspace_id = ${ws} and seq = 2`);

    // Incremental only reads rows past the checkpoint → the old tamper is missed.
    const inc = await incr(ws);
    expect(inc.find((r) => r.workspace_id === ws)!.ok).toBe(true);

    // The full verifier recomputes from genesis → catches it at seq 2.
    const f = await full(ws);
    const frow = f.find((r) => r.workspace_id === ws)!;
    expect(frow.ok).toBe(false);
    expect(Number(frow.first_bad_seq)).toBe(2);

    // The weekly full re-verify path (resetFirst) also catches it.
    const { tampered } = await verifyAuditChains({ resetFirst: true });
    expect(tampered.some((t) => t.workspaceId === ws && t.firstBadSeq === 2)).toBe(true);
  });

  it('full verifier detects a seq gap from a deleted row', async () => {
    const ws = await provisionWs('gap');
    await addEvents(ws, 4);
    await tamperUpdate(ws, 2, (tx) =>
      tx`delete from audit_events where workspace_id = ${ws} and seq = 2`);
    const f = await full(ws);
    const frow = f.find((r) => r.workspace_id === ws)!;
    expect(frow.ok).toBe(false);
    expect(Number(frow.first_bad_seq)).toBe(2);
  });

  it('a clean chain verifies via the full read-only verifier with no checkpoint side-effects', async () => {
    const ws = await provisionWs('fullclean');
    await addEvents(ws, 3);
    const f = await full(ws);
    expect(f.find((r) => r.workspace_id === ws)!.ok).toBe(true);
    expect(await checkpoint(ws)).toBeNull();                     // full writes no checkpoint
  });

  it('checkpoint cascade-deletes with its workspace', async () => {
    const slug = `av-cascade-${RUN}`;
    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${slug}, ${slug}) as provision_brand`;
    await addEvents(ws, 2);
    await incr(ws);
    expect(await checkpoint(ws)).not.toBeNull();
    await sql`delete from workspaces where id = ${ws}`;
    expect(await checkpoint(ws)).toBeNull();
  });
});
