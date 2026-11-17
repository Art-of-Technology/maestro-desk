import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getDb } from './lib/db.js';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
runDbTests('Space Casino backoffice v2 migration', () => {
  it('preserves IDs, custom links, other brands and erased records, and is repeatable', async () => {
    const migration = readFileSync(new URL('../../db/migrations/20261117120000_space_casino_backoffice_v2.sql', import.meta.url), 'utf8');
    const schema = 'backoffice_test_' + crypto.randomUUID().replaceAll('-', '');
    await getDb().begin(async tx => {
      await tx.unsafe(`create schema ${schema}`);
      await tx.unsafe(`set local search_path = ${schema}, public`);
      await tx`create table workspaces (id int primary key, maestro_brand_id uuid)`;
      await tx`create table customers (id int primary key, workspace_id int, backoffice_url text, erased_at timestamptz)`;
      await tx`insert into workspaces values (1, '58d5016a-91bb-49e6-a9be-b3f36f08afde'), (2, null)`;
      const old = 'https://bo.spacecasino.com/Member/Detail/';
      const urls = [old + '50994', old + '00012', 'https://custom.example/member/5', old + '5?tab=notes', old + '../5', null, old + '6', old + '7'];
      for (const [i, url] of urls.entries()) {
        await tx`insert into customers values (${i}, ${i === 6 ? 2 : 1}, ${url}, ${i === 7 ? new Date() : null})`;
      }
      await tx.unsafe(migration);
      const first = await tx`select * from customers order by id`;
      expect(first.map(r => r.backoffice_url)).toEqual([
        'https://backofficev2.spacecasino.com/members/50994',
        'https://backofficev2.spacecasino.com/members/00012', ...urls.slice(2),
      ]);
      await tx.unsafe(migration);
      const second = await tx`select * from customers order by id`;
      expect([...second]).toEqual([...first]);
      await tx.unsafe(`drop schema ${schema} cascade`);
    });
  });
});
