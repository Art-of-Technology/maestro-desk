import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { parseReportPeriod } from './lib/dashboard-report.js';

test('report API validates date ordering and timezone', () => {
  expect(parseReportPeriod('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'Europe/London')).not.toBeNull();
  expect(parseReportPeriod('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')).toBeNull();
  expect(parseReportPeriod('yesterday', 'today')).toBeNull();
  expect(parseReportPeriod('2026-02-30T00:00:00Z', '2026-03-02T00:00:00Z')).toBeNull();
  expect(parseReportPeriod('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'Invalid/Zone')).toBeNull();
});

(process.env.RUN_DB_TESTS ? describe : describe.skip)('Dashboard database totals', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let ws: string;
  const period = parseReportPeriod('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'Europe/London')!;
  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    const slug = `report-${Date.now()}`;
    const [workspace] = await sql`select provision_brand(${slug}, ${slug}) id`;
    ws = workspace.id;
    const [customer] = await sql`insert into customers (workspace_id, display_id, first_name)
      values (${ws}, 'REPORT-CUSTOMER', 'Report fixture') returning id`;
    // More than one normal ticket page, plus exact end-boundary and old work.
    await sql`insert into tickets (workspace_id, customer_id, display_id, subject, status_key, priority_key, created_at)
      select ${ws}::uuid, ${customer.id}::uuid, 'REPORT-' || n, 'Period test', 'pending', 'normal', '2026-01-01T00:00:00Z'::timestamptz
      from generate_series(1, 205) n`;
    await sql`insert into tickets (workspace_id, customer_id, display_id, subject, status_key, priority_key, created_at, resolved_at)
      values (${ws}, ${customer.id}, 'OLD-RESOLVED', 'Old work resolved today', 'resolved', 'normal', '2025-12-01', '2026-01-01T12:00:00Z'),
             (${ws}, ${customer.id}, 'END', 'Next day', 'open', 'normal', '2026-01-02T00:00:00Z', null)`;
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, created_at)
      select ${ws}::uuid, id, 'agent', 'Test agent', 'A reply during the period', '2026-01-01T23:59:59Z'::timestamptz
      from tickets where workspace_id = ${ws} and display_id = 'OLD-RESOLVED'`;
  });
  afterAll(async () => { if (ws) await sql`delete from workspaces where id = ${ws}`; });
  test('uses event dates, full workspace counts, and exclusive period end', async () => {
    const { dashboardReport } = await import('./lib/dashboard-report.js');
    const report = await dashboardReport(ws, crypto.randomUUID(), period);
    expect(report.created).toBe(205);
    expect(report.resolved).toBe(1);
    expect(report.replies).toBe(1);
    expect(report.byStatus).toEqual({ pending: 205 });
    expect(report.volume).toEqual([{ day: '2026-01-01', n: 205 }]);
    const empty = await dashboardReport(crypto.randomUUID(), crypto.randomUUID(), period);
    expect(empty.created).toBe(0);
    expect(empty.recent).toEqual([]);
  });
});
