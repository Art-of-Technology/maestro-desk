import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getDb } from './lib/db.js';
import { playerBackofficeUrl } from './lib/player-backoffice.js';

const workspaceId = '69a587ed-4487-427a-a06c-610d98d83149';
const customerId = 'f5f8d68e-e74b-4578-a912-bf27c15b121a';
const brandId = '58d5016a-91bb-49e6-a9be-b3f36f08afde';
const migration = readFileSync(new URL('../../db/migrations/20260908100500_import_m25_account_details.sql', import.meta.url), 'utf8');

it('only builds verified Space Casino member links', () => {
  expect(playerBackofficeUrl(brandId, '50119')).toBe('https://bo.spacecasino.com/Member/Detail/50119');
  for (const id of [null, '', '../1', '1?admin=true', 'https://example.com', 'global-id']) {
    expect(playerBackofficeUrl(brandId, id)).toBeNull();
  }
  expect(playerBackofficeUrl('another-brand', '50119')).toBeNull();
  expect(playerBackofficeUrl(null, '50119')).toBeNull();
});

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
runDbTests('verified M25 import', () => {
  for (const scenario of ['absent', 'blank', 'preserve', 'wrong identity', 'wrong brand', 'erased', 'deleted', 'merged']) {
    it(`handles ${scenario} without overwriting or resurrecting records`, async () => {
      const rollback = new Error('rollback fixture');
      try {
        await getDb().begin(async tx => {
          if (scenario !== 'absent') {
            await tx`insert into workspaces(id,name,slug,maestro_brand_id) values
              (${workspaceId},'Space Casino','spacecasino',${scenario === 'wrong brand' ? null : brandId})`;
            const [survivor] = await tx`insert into customers(workspace_id,display_id)
              values (${workspaceId},'M-survivor') returning id`;
            await tx`insert into customers ${tx({
              id: customerId, workspace_id: workspaceId, display_id: 'M25',
              maestro_user_id: scenario === 'wrong identity' ? 'another-player' : '50119',
              maestro_member_id: scenario === 'preserve' ? 'saved-global-id' : null,
              since: scenario === 'preserve' ? '2020-01-02' : null,
              backoffice_url: scenario === 'preserve' ? 'https://example.com/saved' : null,
              erased_at: scenario === 'erased' ? new Date() : null,
              deleted_at: scenario === 'deleted' ? new Date() : null,
              merged_into_customer_id: scenario === 'merged' ? survivor.id : null,
            })}`;
          }
          const before = await tx`select * from customers where id = ${customerId}`;
          await tx.unsafe(migration);
          await tx.unsafe(migration);
          const after = await tx`select * from customers where id = ${customerId}`;
          const audit = await tx`select action from audit_events where target_id = ${customerId}`;
          if (scenario === 'blank') {
            expect(after[0].maestro_member_id).toBe('332f9967fcd142989ab5a2715c5cc802');
            expect(new Date(after[0].since).toISOString().slice(0, 10)).toBe('2026-08-30');
            expect(after[0].backoffice_url).toBe(playerBackofficeUrl(brandId, '50119'));
            expect(audit.map(a => a.action)).toEqual(['customer.account_details_imported']);
            const [chain] = await tx`select ok from audit_events_verify(${workspaceId})`;
            expect(chain.ok).toBe(true);
          } else {
            expect(after).toEqual(before);
            expect(audit).toHaveLength(0);
          }
          throw rollback;
        });
      } catch (error) { if (error !== rollback) throw error; }
    });
  }
});
