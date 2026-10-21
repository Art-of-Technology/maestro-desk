import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getDb } from './lib/db.js';
import type { TransactionSql } from 'postgres';

const migration = readFileSync(new URL('../../db/migrations/20261021160000_archive_studio_acceptance.sql', import.meta.url), 'utf8');
const slug = 'studio-acceptance-20261008-d4628444';
const name = 'Studio Acceptance 20261008';
const rollback = new Error('rollback archive fixture');

async function retainedBrands(tx: TransactionSql) {
  for (const [brandName, brandSlug] of [['Space Casino', 'spacecasino'], ['Test Casino', 'test-casino']]) {
    if (!(await tx`select id from workspaces where slug=${brandSlug}`).length) {
      await tx`select provision_brand(${brandName},${brandSlug})`;
    }
  }
}

(process.env.RUN_DB_TESTS ? describe : describe.skip)('Studio Acceptance archive', () => {
  it('preserves data and mapping, leaves other brands unchanged, and audits once on repeated runs', async () => {
    try {
      await getDb().begin(async tx => {
        await retainedBrands(tx);
        const retained = await tx`select * from workspaces where slug in ('spacecasino','test-casino') order by slug`;
        const [target] = await tx`select provision_brand(${name},${slug}) id`;
        const brandId = randomUUID();
        await tx`update workspaces set maestro_brand_id=${brandId} where id=${target.id}`;
        const [customer] = await tx`insert into customers(workspace_id,display_id,first_name)
          values(${target.id},'ARCHIVE-STUDIO-C1','Synthetic') returning id`;
        const [ticket] = await tx`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key)
          values(${target.id},${customer.id},'ARCHIVE-STUDIO-T1','Preserve this record','open','normal') returning id`;
        await tx.unsafe(migration);
        await tx.unsafe(migration);
        const [archived] = await tx`select deleted_at,maestro_brand_id from workspaces where id=${target.id}`;
        expect(archived.deleted_at).not.toBeNull();
        expect(archived.maestro_brand_id).toBe(brandId);
        expect((await tx`select id from customers where id=${customer.id}`).length).toBe(1);
        expect((await tx`select id from tickets where id=${ticket.id}`).length).toBe(1);
        expect((await tx`select id from audit_events where workspace_id=${target.id} and action='brand.archived'`).length).toBe(1);
        const after = await tx`select * from workspaces where slug in ('spacecasino','test-casino') order by slug`;
        expect([...after]).toEqual([...retained]);
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
  });

  for (const mismatch of ['target name', 'retained brand suspended']) {
    it(`refuses to archive when ${mismatch}`, async () => {
      await expect(getDb().begin(async tx => {
        await retainedBrands(tx);
        await tx`select provision_brand(${mismatch === 'target name' ? 'Unexpected brand' : name},${slug})`;
        if (mismatch === 'retained brand suspended') await tx`update workspaces set suspended_at=now() where slug='test-casino'`;
        await tx.unsafe(migration);
      })).rejects.toThrow('Workspace archive identity or retained-brand checks failed');
    });
  }
});
