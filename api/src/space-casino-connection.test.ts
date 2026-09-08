import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getDb } from './lib/db.js';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
const workspaceId = '69a587ed-4487-427a-a06c-610d98d83149';
const brandId = '58d5016a-91bb-49e6-a9be-b3f36f08afde';
const migration = readFileSync(new URL('../../db/migrations/20260908092000_connect_space_casino_maestro.sql', import.meta.url), 'utf8');

runDbTests('Space Casino connection migration', () => {
  it('does nothing in environments without the production workspace', async () => {
    const rollback = new Error('rollback test fixture');
    try {
      await getDb().begin(async tx => {
        expect(await tx`select id from workspaces where id = ${workspaceId}`).toHaveLength(0);
        await tx.unsafe(migration);
        expect(await tx`select id from workspaces where id = ${workspaceId}`).toHaveLength(0);
        throw rollback;
      });
    } catch (err) { if (err !== rollback) throw err; }
  });

  it('connects once despite a deleted duplicate, preserves customers, and produces a valid audit chain', async () => {
    const rollback = new Error('rollback test fixture');
    try {
      await getDb().begin(async tx => {
        await tx`insert into workspaces(id,name,slug) values (${workspaceId}, 'Space Casino', 'spacecasino')`;
        await tx`insert into workspaces(name,slug,maestro_brand_id,deleted_at) values ('Deleted duplicate','space-deleted-duplicate',${brandId},now())`;
        const [customer] = await tx`insert into customers(workspace_id,display_id) values (${workspaceId},'M25') returning id`;
        await tx.unsafe(migration);
        await tx.unsafe(migration);
        const [ws] = await tx`select maestro_brand_id from workspaces where id = ${workspaceId}`;
        expect(ws.maestro_brand_id).toBe(brandId);
        const [saved] = await tx`select workspace_id from customers where id = ${customer.id}`;
        expect(saved.workspace_id).toBe(workspaceId);
        const audits = await tx`select action from audit_events where workspace_id = ${workspaceId}`;
        expect(audits.map(a => a.action)).toEqual(['brand.maestro_connected']);
        const [chain] = await tx`select ok from audit_events_verify(${workspaceId})`;
        expect(chain.ok).toBe(true);
        throw rollback;
      });
    } catch (err) { if (err !== rollback) throw err; }
  });

  for (const scenario of ['wrong name', 'already connected', 'duplicate brand']) {
    it(`refuses ${scenario} without changing the mapping`, async () => {
      let failure: unknown;
      try {
        await getDb().begin(async tx => {
          await tx`insert into workspaces(id,name,slug,maestro_brand_id) values (
            ${workspaceId}, ${scenario === 'wrong name' ? 'Different casino' : 'Space Casino'}, 'spacecasino',
            ${scenario === 'already connected' ? '00000000-0000-4000-8000-000000000001' : null})`;
          if (scenario === 'duplicate brand') {
            await tx`insert into workspaces(name,slug,maestro_brand_id) values ('Duplicate','space-connection-test-duplicate',${brandId})`;
          }
          await tx.unsafe(migration);
        });
      } catch (err) { failure = err; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/identity does not match|different Maestro brand|belongs to another workspace/);
      expect(await getDb()`select id from workspaces where id = ${workspaceId}`).toHaveLength(0);
    });
  }
});
