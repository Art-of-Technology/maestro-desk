import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import {
  applyAuditRepair,
  parseRepairRequest,
  previewAuditRepair,
  type RepairRequest,
} from '../scripts/lib/audit-repair.js';
import {
  executeRecordedRepair,
  writeRepairEvidence,
} from '../scripts/lib/repair-evidence.js';
import { configureRuntimeAccess } from '../scripts/lib/runtime-access.js';

const run = process.env.RUN_DB_TESTS ? describe : describe.skip;
run('historical audit repair (operator only)', () => {
  let sql: Sql;
  const workspaces: string[] = [];
  let database: string;
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw Error('Synthetic database required');
    database = new URL(process.env.DATABASE_URL).pathname.slice(1);
    sql = postgres(process.env.DATABASE_URL, {
      max: 5,
      prepare: false,
      onnotice: () => {},
    });
  });
  afterAll(async () => {
    for (const id of workspaces)
      await sql`delete from workspaces where id=${id}`;
    await sql.end();
  });
  async function fixture() {
    const key = crypto.randomUUID();
    const [w] = await sql`select provision_brand(${key},${key}) id`;
    workspaces.push(w.id);
    const [c] =
      await sql`insert into customers(workspace_id,display_id,first_name) values(${w.id},${key},'Synthetic') returning id`;
    // Rehearse pre-minimisation history without changing the hash function.
    const rows = await sql.begin(async (tx) => {
      await tx`alter table audit_events disable trigger audit_events_00_minimise`;
      const created =
        await tx`insert into audit_events(workspace_id,action,target_type,target_id,metadata,actor_ip,actor_ua)
        select ${w.id},'customer.updated','customer',${c.id},'{"email":"HISTORICAL_PRIVATE","notes":2}',
          '192.0.2.1'::inet,'PRIVATE_AGENT' from generate_series(1,3) returning id`;
      await tx`alter table audit_events enable trigger audit_events_00_minimise`;
      return created;
    });
    const request: RepairRequest = {
      operationId: crypto.randomUUID(),
      database,
      workspaceId: w.id,
      selectedIds: [rows[0].id],
      excludedIds: [rows[1].id],
      decisionId: crypto.randomUUID(),
      holdReviewId: crypto.randomUUID(),
      holds: 'none_in_workspace',
    };
    return { request, rows, customer: c.id };
  }
  async function history(workspace: string) {
    return JSON.stringify(
      await sql`select to_jsonb(a) row from audit_events a where workspace_id=${workspace} order by seq`,
    );
  }
  async function intact(workspace: string) {
    expect(
      (await sql`select * from audit_events_verify(${workspace})`)[0].ok,
    ).toBe(true);
    expect(
      (
        await sql`select tgenabled from pg_trigger where tgrelid='audit_events'::regclass and tgname='audit_events_no_update'`
      )[0].tgenabled,
    ).toBe('O');
  }
  it('previews read-only, sanitises only approved content, preserves other tenants and records the transition', async () => {
    const f = await fixture(),
      other = await fixture();
    const before = await history(f.request.workspaceId),
      otherBefore = await history(other.request.workspaceId);
    await sql`select * from audit_events_verify_incremental(${other.request.workspaceId})`;
    const checkpointBefore = JSON.stringify(
      await sql`select * from audit_verify_checkpoints where workspace_id=${other.request.workspaceId}`,
    );
    const p = await previewAuditRepair(sql, f.request);
    expect(await history(f.request.workspaceId)).toBe(before);
    expect(JSON.stringify(p)).not.toContain('HISTORICAL_PRIVATE');
    const receipt = await applyAuditRepair(sql, p);
    const receiptDirectory = mkdtempSync(
      join(tmpdir(), 'respovia-jsonb-order-'),
    );
    writeRepairEvidence(
      join(receiptDirectory, f.request.operationId + '.committed.json'),
      receipt,
    );
    expect(
      (await executeRecordedRepair(sql, p, receiptDirectory, true)).status,
    ).toBe('receipt_recovered');
    expect(receipt.integrityTransition).toBe(true);
    expect(receipt.newTail.hash).not.toBe(p.snapshot.oldTail.hash);
    const rows =
      await sql`select id,metadata,actor_ip,actor_ua from audit_events where workspace_id=${f.request.workspaceId} order by seq`;
    expect(rows[0].metadata).toEqual({ notes: 2 });
    expect(rows[0].actor_ip).toBeNull();
    expect(rows[0].actor_ua).toBeNull();
    expect(rows[1].metadata.email).toBe('HISTORICAL_PRIVATE');
    expect(rows[2].metadata.email).toBe('HISTORICAL_PRIVATE');
    expect(await history(other.request.workspaceId)).toBe(otherBefore);
    expect(
      JSON.stringify(
        await sql`select * from audit_verify_checkpoints where workspace_id=${other.request.workspaceId}`,
      ),
    ).toBe(checkpointBefore);
    await intact(f.request.workspaceId);
    expect(
      (
        await sql`select * from audit_events_verify_incremental(${f.request.workspaceId})`
      )[0].ok,
    ).toBe(true);
    expect(await applyAuditRepair(sql, p)).toEqual(receipt);
    expect(
      await sql`select id from audit_repair_receipts where id=${f.request.operationId}`,
    ).toHaveLength(1);
    await expect(
      Promise.resolve(
        sql`update audit_repair_receipts set receipt='{}' where id=${f.request.operationId}`,
      ),
    ).rejects.toThrow('audit_repair_receipts is append-only');
  });
  it('refuses overlapping, wrong-workspace, uncertain and held scopes', async () => {
    const f = await fixture(),
      other = await fixture();
    expect(() =>
      parseRepairRequest({ ...f.request, excludedIds: f.request.selectedIds }),
    ).toThrow();
    expect(() =>
      parseRepairRequest({ ...f.request, holds: 'active' }),
    ).toThrow();
    await expect(
      previewAuditRepair(sql, {
        ...f.request,
        selectedIds: [other.rows[0].id],
      }),
    ).rejects.toThrow();
    const [orphan] =
      await sql`insert into audit_events(workspace_id,action,target_type,target_id)
      values(${f.request.workspaceId},'ticket.deleted','ticket',${crypto.randomUUID()}) returning id`;
    await expect(
      previewAuditRepair(sql, { ...f.request, selectedIds: [orphan.id] }),
    ).rejects.toThrow('uncertain');
    await intact(f.request.workspaceId);
  });
  it('refuses known merge history and a target belonging to another workspace', async () => {
    const f = await fixture(),
      other = await fixture();
    const [cross] =
      await sql`insert into audit_events(workspace_id,action,target_type,target_id)
      values(${f.request.workspaceId},'customer.updated','customer',${other.customer}) returning id`;
    await expect(
      previewAuditRepair(sql, { ...f.request, selectedIds: [cross.id] }),
    ).rejects.toThrow('uncertain');
    const [source] =
      await sql`insert into customers(workspace_id,display_id) values(${f.request.workspaceId},${crypto.randomUUID()}) returning id`;
    await sql`insert into customer_merges(workspace_id,source_customer_id,primary_customer_id)
      values(${f.request.workspaceId},${source.id},${f.customer})`;
    await expect(previewAuditRepair(sql, f.request)).rejects.toThrow(
      'merge history',
    );
  });
  it('refuses an oversized chain before attempting repair', async () => {
    const f = await fixture();
    await sql`insert into audit_events(workspace_id,action) select ${f.request.workspaceId},'fixture.bulk' from generate_series(1,5000)`;
    await expect(previewAuditRepair(sql, f.request)).rejects.toThrow('5000');
    expect(
      await sql`select id from audit_repair_receipts where id=${f.request.operationId}`,
    ).toHaveLength(0);
  }, 20000);
  it('refuses stale history, changed policy and damaged chain or checkpoint', async () => {
    const f = await fixture();
    const p = await previewAuditRepair(sql, f.request);
    await sql`insert into audit_events(workspace_id,action) values(${f.request.workspaceId},'fixture.appended')`;
    await expect(applyAuditRepair(sql, p)).rejects.toThrow('stale');
    const fresh = await previewAuditRepair(sql, f.request);
    // Search-path alteration changes pg_get_functiondef without changing behaviour.
    await sql`alter function audit_metadata_facts(text,jsonb) set search_path=public,pg_catalog`;
    try {
      await expect(applyAuditRepair(sql, fresh)).rejects.toThrow('stale');
    } finally {
      await sql`alter function audit_metadata_facts(text,jsonb) set search_path=pg_catalog,public`;
    }
    await sql`insert into audit_verify_checkpoints(workspace_id,last_seq,last_row_hash) values(${f.request.workspaceId},999,decode('00','hex'))`;
    await expect(previewAuditRepair(sql, f.request)).rejects.toThrow(
      'checkpoint',
    );
    await sql`delete from audit_verify_checkpoints where workspace_id=${f.request.workspaceId}`;
    await sql.begin(async (tx) => {
      await tx`alter table audit_events disable trigger audit_events_no_update`;
      await tx`update audit_events set metadata='{}' where id=${f.rows[0].id}`;
      await tx`alter table audit_events enable trigger audit_events_no_update`;
    });
    await expect(previewAuditRepair(sql, f.request)).rejects.toThrow('damaged');
  });
  it('fails promptly against an in-flight writer or verifier and leaves history unchanged', async () => {
    const f = await fixture();
    const p = await previewAuditRepair(sql, f.request),
      before = await history(f.request.workspaceId);
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(727573707)`;
      await expect(applyAuditRepair(sql, p)).rejects.toThrow(
        'Migration or another repair',
      );
    });
    await sql.begin(async (tx) => {
      await tx`lock table audit_events in row exclusive mode`;
      await expect(applyAuditRepair(sql, p)).rejects.toMatchObject({
        code: '55P03',
      });
    });
    await sql.begin(async (tx) => {
      await tx`lock table audit_verify_checkpoints in row exclusive mode`;
      await expect(applyAuditRepair(sql, p)).rejects.toMatchObject({
        code: '55P03',
      });
    });
    expect(await history(f.request.workspaceId)).toBe(before);
    await intact(f.request.workspaceId);
  });
  it('rolls back content, checkpoints and trigger state if receipt insertion fails', async () => {
    const f = await fixture();
    const p = await previewAuditRepair(sql, f.request),
      before = await history(f.request.workspaceId);
    await sql`create function synthetic_receipt_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic failure'; end$$`;
    await sql`create trigger synthetic_receipt_failure before insert on audit_repair_receipts for each row execute function synthetic_receipt_failure()`;
    try {
      await expect(applyAuditRepair(sql, p)).rejects.toThrow(
        'synthetic failure',
      );
    } finally {
      await sql`drop trigger synthetic_receipt_failure on audit_repair_receipts`;
      await sql`drop function synthetic_receipt_failure()`;
    }
    expect(await history(f.request.workspaceId)).toBe(before);
    expect(
      await sql`select id from audit_repair_receipts where id=${f.request.operationId}`,
    ).toHaveLength(0);
    expect(
      await sql`select * from audit_verify_checkpoints where workspace_id=${f.request.workspaceId}`,
    ).toHaveLength(0);
    await intact(f.request.workspaceId);
    await applyAuditRepair(sql, p);
  });
  it('rolls back after a terminated database connection, then safely retries', async () => {
    const f = await fixture(),
      p = await previewAuditRepair(sql, f.request),
      before = await history(f.request.workspaceId);
    await sql`create function synthetic_receipt_disconnect() returns trigger language plpgsql as $$begin raise notice 'synthetic-repair-receipt-boundary'; perform pg_terminate_backend(pg_backend_pid()); return new; end$$`;
    await sql`create trigger synthetic_receipt_disconnect before insert on audit_repair_receipts for each row execute function synthetic_receipt_disconnect()`;
    try {
      const child = spawnSync(
        'node',
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
        import postgres from 'postgres';
        import {applyAuditRepair} from './scripts/lib/audit-repair.ts';
        const db=postgres(process.env.DATABASE_URL,{max:1,prepare:false,onnotice:n=>{
          if(n.message==='synthetic-repair-receipt-boundary')console.log('receipt-boundary-reached');
        }});
        try { await applyAuditRepair(db,JSON.parse(process.env.TEST_PROPOSAL)); process.exitCode=2; }
        catch(error) { process.exitCode=1; }
        finally { await db.end({timeout:1}); }
      `,
        ],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: { ...process.env, TEST_PROPOSAL: JSON.stringify(p) },
        },
      );
      // The driver may terminate the process abruptly on a killed backend.
      // Establish that the fault occurred after rewriting, then verify rollback
      // through an independent connection rather than trusting CLI exit alone.
      expect(child.stdout).toContain('receipt-boundary-reached');
      expect(child.status).toBe(1);
    } finally {
      await sql`drop trigger synthetic_receipt_disconnect on audit_repair_receipts`;
      await sql`drop function synthetic_receipt_disconnect()`;
    }
    expect(await history(f.request.workspaceId)).toBe(before);
    expect(
      await sql`select id from audit_repair_receipts where id=${f.request.operationId}`,
    ).toHaveLength(0);
    await intact(f.request.workspaceId);
    await applyAuditRepair(sql, p);
    // A new writer can extend the repaired chain through the ordinary guard.
    await sql`insert into audit_events(workspace_id,action) values(${f.request.workspaceId},'fixture.after_repair')`;
    await intact(f.request.workspaceId);
  }, 20000);
  it('serialises competing repairs and refuses a disabled guard or a modified proposal', async () => {
    const f = await fixture(),
      p = await previewAuditRepair(sql, f.request);
    await expect(
      applyAuditRepair(sql, { ...p, proposalHash: '0'.repeat(64) }),
    ).rejects.toThrow('fingerprint');
    await sql`alter table audit_events disable trigger audit_events_no_update`;
    try {
      await expect(applyAuditRepair(sql, p)).rejects.toThrow('guard');
    } finally {
      await sql`alter table audit_events enable trigger audit_events_no_update`;
    }
    const results = await Promise.allSettled([
      applyAuditRepair(sql, p),
      applyAuditRepair(sql, p),
    ]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(
      await sql`select id from audit_repair_receipts where id=${f.request.operationId}`,
    ).toHaveLength(1);
    await applyAuditRepair(sql, p);
    await intact(f.request.workspaceId);
  });
  it('recovers a committed receipt after external output fails, without repeating the repair', async () => {
    const f = await fixture(),
      p = await previewAuditRepair(sql, f.request);
    const directory = mkdtempSync(join(tmpdir(), 'respovia-repair-'));
    // Real transaction, injected filesystem failure at the post-commit boundary.
    const faulty = new Proxy(sql, {
      get(target, property) {
        if (property !== 'begin') return Reflect.get(target, property);
        return async (...args: unknown[]) => {
          const result = await (target.begin as Function)(...args);
          if (result?.status === 'committed')
            mkdirSync(
              join(directory, f.request.operationId + '.committed.json'),
            );
          return result;
        };
      },
    });
    await expect(executeRecordedRepair(faulty, p, directory)).rejects.toThrow();
    expect(
      await sql`select id from audit_repair_receipts where id=${f.request.operationId}`,
    ).toHaveLength(1);
    const after = await history(f.request.workspaceId);
    const recovery = mkdtempSync(join(tmpdir(), 'respovia-recovered-'));
    const result = await executeRecordedRepair(sql, p, recovery, true);
    expect(result.status).toBe('receipt_recovered');
    expect((await executeRecordedRepair(sql, p, recovery, true)).status).toBe(
      'receipt_recovered',
    );
    expect(
      JSON.parse(readFileSync(result.receiptPath, 'utf8')).proposal
        .proposalHash,
    ).toBe(p.proposalHash);
    expect(await history(f.request.workspaceId)).toBe(after);
    const changed = await previewAuditRepair(sql, {
      ...f.request,
      selectedIds: [f.rows[2].id],
    });
    await expect(applyAuditRepair(sql, changed)).rejects.toThrow(
      'different proposal',
    );
    expect(() => writeRepairEvidence(result.receiptPath, {})).toThrow();
  });
  it('requires pending evidence before apply and refuses a restore/custody mismatch', async () => {
    const f = await fixture(),
      p = await previewAuditRepair(sql, f.request),
      before = await history(f.request.workspaceId);
    const directory = mkdtempSync(join(tmpdir(), 'respovia-repair-mismatch-'));
    await expect(
      executeRecordedRepair(sql, p, join(directory, 'missing')),
    ).rejects.toThrow();
    expect(await history(f.request.workspaceId)).toBe(before);
    writeRepairEvidence(
      join(directory, f.request.operationId + '.committed.json'),
      { restored: true },
    );
    await expect(executeRecordedRepair(sql, p, directory)).rejects.toThrow(
      'restore',
    );
    expect(await history(f.request.workspaceId)).toBe(before);
  });
  it('does not grant runtime access to repair receipts or maintenance', async () => {
    const role = 'repair_runtime_' + Date.now();
    await sql`create role ${sql(role)} login password 'synthetic-repair-only'`;
    const url = new URL(process.env.DATABASE_URL!);
    url.username = role;
    url.password = 'synthetic-repair-only';
    const runtime = postgres(url.toString(), { onnotice: () => {} });
    try {
      await configureRuntimeAccess(sql, role, database, true);
      await expect(
        Promise.resolve(runtime`select * from public.audit_repair_receipts`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        Promise.resolve(
          runtime`insert into public.audit_repair_receipts default values`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        Promise.resolve(
          runtime`alter table public.audit_events disable trigger audit_events_no_update`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await runtime.end();
      await sql`drop owned by ${sql(role)}`;
      await sql`drop role ${sql(role)}`;
    }
  });
});
