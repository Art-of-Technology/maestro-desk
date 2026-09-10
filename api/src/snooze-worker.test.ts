import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { clearTicketSnooze } from './lib/ticket-snooze.js';
import { createSnoozeWorker, processExpiredSnoozes } from './lib/snooze-worker.js';

const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw Error('Timed out waiting for worker');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
describe('snooze worker lifecycle', () => {
  it('runs immediately, prevents overlapping ticks, and drains on stop', async () => {
    let runs = 0, release!: () => void, aborted = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const worker = createSnoozeWorker(async signal => {
      runs++; await held; aborted = Boolean(signal?.aborted);
      return { processed: 0, failed: 0, scanned: 0 };
    });
    worker.start(5); worker.start(5);
    try {
      await waitFor(() => runs === 1);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(runs).toBe(1);
      let stopped = false;
      const stop = worker.stop().then(() => { stopped = true; });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(stopped).toBe(false);
      release(); await stop;
      expect(aborted).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(runs).toBe(1);
    } finally { release(); await worker.stop(); }
  });
  it('reports failure and retries on a later tick', async () => {
    let runs = 0, reported = 0;
    const worker = createSnoozeWorker(async () => {
      runs++;
      if (runs === 1) return { processed: 0, failed: 1, scanned: 1 };
      return { processed: 0, failed: 0, scanned: 0 };
    }, async () => { reported++; });
    worker.start(5);
    try { await waitFor(() => runs >= 2); expect(reported).toBe(1); }
    finally { await worker.stop(); }
  });
});

const run = process.env.RUN_DB_TESTS ? describe : describe.skip;
run('server snooze expiry (PostgreSQL)', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const suffix = randomUUID();
  const workspaces: string[] = [], customers: string[] = [];
  const makeTicket = async (status = 'pending', workspace = 0, until: Date | null = new Date(Date.now() - 60_000)) => {
    const [t] = await sql`insert into tickets(workspace_id, customer_id, display_id, subject, status_key, priority_key,
      snoozed_until, snoozed_at, snooze_reason, closure_reason, closed_at) values (${workspaces[workspace]}, ${customers[workspace]}, ${randomUUID()},
      'Worker fixture', ${status}, 'normal', ${until}, now() - interval '2 hours', 'Awaiting reply',
      ${status === 'closed' ? 'other' : null}, ${status === 'closed' ? new Date() : null}) returning id`;
    return t.id as string;
  };
  const state = async (id: string) => (await sql`select * from tickets where id = ${id}`)[0];
  const history = (id: string) => sql`select * from events where entity_id = ${id} and kind = 'snooze'`;
  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    for (const part of ['a', 'b']) {
      const [ws] = await sql`select provision_brand(${'Worker ' + part}, ${'worker-' + part + '-' + suffix}) as id`;
      workspaces.push(ws.id);
      const [customer] = await sql`insert into customers(workspace_id, display_id, first_name) values (${ws.id}, 'M1', 'Worker') returning id`;
      customers.push(customer.id);
    }
  });
  afterAll(async () => {
    for (const id of workspaces) await sql`delete from workspaces where id = ${id}`;
  });

  it('wakes all four work statuses without any browser or HTTP request, including downtime backlog', async () => {
    const ids = [];
    for (const status of ['open', 'pending', 'escalated', 'gdpr']) ids.push(await makeTicket(status));
    ids.push(await makeTicket('pending', 1, new Date(Date.now() - 7 * 86400000)));
    await processExpiredSnoozes();
    for (const id of ids) {
      const t = await state(id), events = await history(id);
      expect(t.snoozed_until).toBeNull(); expect(t.snooze_reason).toBeNull();
      expect(t.snooze_woken_at).toBeInstanceOf(Date);
      expect(events).toHaveLength(1);
      expect(events[0].author_label).toBe('System'); expect(events[0].author_user_id).toBeNull();
      const [audit] = await sql`select metadata, workspace_id from audit_events where target_id = ${id} and action = 'ticket.snooze.changed'`;
      expect(audit.metadata.source).toBe('snooze_expired');
      expect(audit.workspace_id).toBe(t.workspace_id);
    }
    await processExpiredSnoozes();
    for (const id of ids) expect(await history(id)).toHaveLength(1);
  });

  it('excludes future, completed, merged and deleted tickets, including legacy automatic requests', async () => {
    const ids = [await makeTicket('resolved'), await makeTicket('closed'), await makeTicket('pending', 0, new Date(Date.now() + 3600000))];
    const deleted = await makeTicket(), merged = await makeTicket();
    await sql`update tickets set deleted_at = now() where id = ${deleted}`;
    await sql`update tickets set merged_into_id = ${ids[0]} where id = ${merged}`;
    ids.push(deleted, merged);
    await processExpiredSnoozes();
    for (const id of ids) {
      await sql.begin(tx => clearTicketSnooze(tx, { workspaceId: workspaces[0], ticketId: id, automatic: true, actorId: null }));
      expect((await state(id)).snoozed_until).not.toBeNull();
      expect(await history(id)).toHaveLength(0);
    }
  });

  it('skips an agent-locked ticket and respects its extended snooze after commit', async () => {
    const id = await makeTicket();
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const change = sql.begin(async tx => {
      await tx`select id from tickets where id = ${id} for update`;
      locked(); await held;
      await tx`update tickets set snoozed_until = now() + interval '1 hour' where id = ${id}`;
    });
    try {
      await ready; await processExpiredSnoozes();
      expect(await history(id)).toHaveLength(0);
    } finally { release(); await change; }
    await processExpiredSnoozes();
    expect((await state(id)).snoozed_until.getTime()).toBeGreaterThan(Date.now());
    expect(await history(id)).toHaveLength(0);
  });

  it('concurrent worker instances and an old browser wake create exactly one event', async () => {
    const id = await makeTicket();
    await Promise.all([processExpiredSnoozes(), processExpiredSnoozes(), sql.begin(tx => clearTicketSnooze(tx, {
      workspaceId: workspaces[0], ticketId: id, automatic: true, actorId: null,
    }))]);
    expect(await history(id)).toHaveLength(1);
    const at = (await state(id)).snooze_woken_at.toISOString();
    await processExpiredSnoozes();
    expect((await state(id)).snooze_woken_at.toISOString()).toBe(at);
  });

  it('rolls back on audit failure, continues other workspaces, and succeeds on retry', async () => {
    const broken = await makeTicket(), healthy = await makeTicket('pending', 1);
    const constraint = 'worker_failure_' + suffix.replaceAll('-', '');
    await sql.unsafe(`alter table audit_events add constraint ${constraint} check (target_id <> '${broken}'::uuid) not valid`);
    try {
      const result = await processExpiredSnoozes();
      expect(result.failed).toBe(1);
      expect((await state(broken)).snoozed_until).not.toBeNull();
      expect(await history(broken)).toHaveLength(0);
      expect((await state(healthy)).snoozed_until).toBeNull();
    } finally { await sql.unsafe(`alter table audit_events drop constraint ${constraint}`); }
    await processExpiredSnoozes();
    expect(await history(broken)).toHaveLength(1);
    for (const ws of workspaces) expect((await sql`select ok from audit_events_verify(${ws})`)[0].ok).toBe(true);
  });

  it('rotates past a full batch of locked tickets so later work is not starved', async () => {
    const rows = await sql`insert into tickets(workspace_id, customer_id, display_id, subject, status_key, priority_key, snoozed_until)
      select ${workspaces[0]}, ${customers[0]}, 'locked-' || n, 'Locked fixture', 'pending', 'normal', now() - interval '2 minutes'
      from generate_series(1, 100) n returning id`;
    const healthy = await makeTicket('pending', 1);
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const lock = sql.begin(async tx => {
      await tx`select id from tickets where id = any(${rows.map(r => r.id)}) order by id for update`;
      locked(); await held;
    });
    try {
      await ready;
      const first = await processExpiredSnoozes();
      expect(first.scanned).toBe(100);
      expect((await processExpiredSnoozes()).processed).toBe(1);
      expect((await state(healthy)).snoozed_until).toBeNull();
      expect(await history(healthy)).toHaveLength(1);
    } finally { release(); await lock; }
  });
});
