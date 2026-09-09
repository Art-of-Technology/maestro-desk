import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
runDbTests('ticket closure migration', () => {
  it('preserves existing rows, provisions existing/new workspaces, and enforces closure metadata', async () => {
    const { getDb } = await import('./lib/db.js');
    const migration = readFileSync(new URL('../../db/migrations/20260908180000_ticket_closure.sql', import.meta.url), 'utf8');
    const schema = 'closure_test_' + crypto.randomUUID().replaceAll('-', '');
    await getDb().begin(async tx => {
      await tx.unsafe(`create schema ${schema}`);
      await tx.unsafe(`set local search_path = ${schema}, public`);
      await tx`create table users (id uuid primary key)`;
      await tx`create table workspaces (id uuid primary key)`;
      await tx`create table ticket_statuses (workspace_id uuid references workspaces(id), key text, label text,
        color text, sort_order int, is_terminal boolean, primary key (workspace_id, key))`;
      await tx`create table tickets (id int primary key, status_key text, subject text, resolved_at timestamptz)`;
      const existing = crypto.randomUUID(), added = crypto.randomUUID();
      await tx`insert into workspaces values (${existing})`;
      await tx`insert into tickets values (1, 'resolved', 'Keep this history', '2026-09-01'), (2, 'open', 'Active work', null)`;
      await tx.unsafe(migration);
      await tx`insert into workspaces values (${added})`;
      const statuses = await tx`select * from ticket_statuses where key = 'closed'`;
      expect(statuses).toHaveLength(2);
      expect(statuses.every(s => s.is_terminal)).toBe(true);
      const [old] = await tx`select subject, status_key, resolved_at, closure_reason from tickets where id = 1`;
      expect(old.subject).toBe('Keep this history');
      expect(old.status_key).toBe('resolved');
      expect(old.resolved_at).toBeTruthy();
      expect(old.closure_reason).toBeNull();
      let missingReasonError: unknown;
      try {
        await tx.savepoint(async save => { await save`update tickets set status_key = 'closed' where id = 2`; });
      } catch (err) { missingReasonError = err; }
      expect(missingReasonError).toMatchObject({ code: '23514' });
      await tx`update tickets set status_key = 'closed', closure_reason = 'other', closed_at = now() where id = 2`;
      let invalidReasonError: unknown;
      try {
        await tx.savepoint(async save => { await save`update tickets set closure_reason = 'invented' where id = 2`; });
      } catch (err) { invalidReasonError = err; }
      expect(invalidReasonError).toMatchObject({ code: '23514' });
      await tx.unsafe(`drop schema ${schema} cascade`);
    });
  });
});
