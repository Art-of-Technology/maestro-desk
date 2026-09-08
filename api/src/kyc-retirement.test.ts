import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getDb } from './lib/db.js';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
const migration = readFileSync(new URL('../../db/migrations/20260908124500_retire_legacy_kyc.sql', import.meta.url), 'utf8');

runDbTests('legacy KYC retirement migration', () => {
  it('scrubs retired values, repairs erased history, preserves active data and can rerun', async () => {
    // Temporary tables shadow the production-shaped tables only on this
    // transaction's connection; no shared test database schema is altered.
    await getDb().begin(async tx => {
      await tx`create temporary table customers (
        id int, workspace_id int, erased_at timestamptz, kyc_status text, mobile text, vip_tier text
      ) on commit drop`;
      await tx`create temporary table customer_merges (
        id int, workspace_id int, source_customer_id int, backfilled_fields jsonb, unmerged_at timestamptz
      ) on commit drop`;
      await tx`insert into customers values
        (1, 1, now(), 'old-erased-value', null, 'Gold'),
        (2, 1, null, 'verified', '+447700123456', 'Silver')`;
      const personal = { first_name: 'Old', last_name: 'Name', username: 'old-user',
        email: 'old@customer.test', mobile: '+447700000000', backoffice_url: 'https://bo.example/old',
        kyc_status: 'verified', jurisdiction: 'MT', maestro_user_id: 'old-id', maestro_member_id: 'old-global' };
      const retained = { brand: 'History', vip_tier: 'Gold', since: '2020-01-01' };
      const values = { ...personal, ...retained };
      await tx`insert into customer_merges values
        (1, 1, 1, ${tx.json(values)}, now()),
        (2, 1, 2, ${tx.json(values)}, null),
        (3, 2, 1, ${tx.json(values)}, now())`;
      for (let run = 0; run < 2; run++) {
        await tx.unsafe(migration);
        const customers = await tx`select to_jsonb(customers) as customer from customers order by id`;
        expect(customers[0].customer).not.toHaveProperty('kyc_status');
        expect(customers[1].customer).not.toHaveProperty('kyc_status');
        expect(customers[1].customer.mobile).toBe('+447700123456');
        expect(customers[1].customer.vip_tier).toBe('Silver');
        const journals = await tx`select * from customer_merges order by id`;
        expect(journals).toHaveLength(3);
        expect(journals[0].backfilled_fields).toEqual(retained);
        expect(journals[0].unmerged_at).not.toBeNull();
        const { kyc_status: _kyc, ...activeValues } = values;
        expect(journals[1].backfilled_fields).toEqual(activeValues);
        expect(journals[1].unmerged_at).toBeNull();
        expect(journals[2].backfilled_fields).toEqual(activeValues);
      }
    });
  });
});
