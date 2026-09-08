import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
runDbTests('CSAT false-marker repair', () => {
  it('clears only unsent, unrated markers and preserves real sends and ratings', async () => {
    const { getDb } = await import('./lib/db.js');
    const migration = readFileSync(new URL('../../db/migrations/20260908160000_csat_send_claim.sql', import.meta.url), 'utf8');
    await getDb().begin(async tx => {
      await tx`create temporary table tickets (
        id int, csat_requested_at timestamptz, csat_token text,
        csat_submitted_at timestamptz, csat_score int, csat_stars int
      ) on commit drop`;
      await tx`set local search_path = pg_temp, public`;
      await tx`insert into tickets values
        (1, now(), null, null, null, null),
        (2, now(), 'sent-token', null, null, null),
        (3, now(), null, now(), null, null),
        (4, now(), null, null, 4, null),
        (5, now(), null, null, null, 5)`;
      await tx.unsafe(migration);
      const rows = await tx`select id, csat_requested_at is not null as requested, csat_send_claim from tickets order by id`;
      expect(rows.map(r => r.requested)).toEqual([false, true, true, true, true]);
      expect(rows.every(r => r.csat_send_claim === null)).toBe(true);
    });
  });
});
