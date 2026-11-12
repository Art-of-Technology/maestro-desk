import { test, expect, describe } from 'bun:test';
import { moveColumn, dropSide, sortCustomers, nextSort } from '../web/js/customers/table-order.js';

const cols = () => [
  { id: 'id', fixed: true, visible: true },
  { id: 'name', fixed: true, visible: true },
  { id: 'username', visible: false },
  { id: 'brand', visible: true },
  { id: 'vip', visible: true },
];
const ids = list => list.map(c => c.id).join(',');

describe('moveColumn', () => {
  test('dragging right lands after the target', () => {
    const c = cols();
    expect(moveColumn(c, 'name', 'brand')).toBe(true);
    expect(ids(c)).toBe('id,username,brand,name,vip');
  });
  test('dragging left lands before the target', () => {
    const c = cols();
    moveColumn(c, 'vip', 'name');
    expect(ids(c)).toBe('id,vip,name,username,brand');
  });
  test('fixed columns move, and can be dropped onto', () => {
    const c = cols();
    moveColumn(c, 'id', 'vip');
    expect(ids(c)).toBe('name,username,brand,vip,id');
    moveColumn(c, 'brand', 'name');
    expect(ids(c)).toBe('brand,name,username,vip,id');
  });
  test('mutates in place and keeps array identity', () => {
    const c = cols(); const ref = c;
    moveColumn(c, 'vip', 'id');
    expect(c).toBe(ref);
    expect(c.length).toBe(5);
  });
  test('no-ops: same column, unknown ids, no drag in progress', () => {
    const c = cols();
    expect(moveColumn(c, 'vip', 'vip')).toBe(false);
    expect(moveColumn(c, 'nope', 'vip')).toBe(false);
    expect(moveColumn(c, 'vip', 'nope')).toBe(false);
    expect(moveColumn(c, null, 'vip')).toBe(false);
    expect(ids(c)).toBe('id,name,username,brand,vip');
  });
});

test('dropSide matches where moveColumn lands', () => {
  const c = cols();
  expect(dropSide(c, 'name', 'vip')).toBe('after');
  expect(dropSide(c, 'vip', 'name')).toBe('before');
  expect(dropSide(c, 'vip', 'vip')).toBe(null);
  expect(dropSide(c, null, 'vip')).toBe(null);
});

const customers = [
  { id: 'CUST-10', first: 'Zoe',  last: 'Adams', username: 'zed',   brand: 'Beta',  vip: 'Bronze',   jurisdiction: 'MGA',  consent: true,  custom: { f1: 'pear' } },
  { id: 'CUST-2',  first: 'adam', last: 'Young', username: 'Alpha', brand: 'alpha', vip: 'Platinum', jurisdiction: 'UKGC', consent: false, custom: { f1: '' } },
  { id: 'CUST-1',  first: 'Bea',  last: 'Mills', username: '',      brand: 'Beta',  vip: 'Gold',     jurisdiction: '',     consent: true },
  { id: 'CUST-30', first: 'Cy',   last: 'Nolan', username: 'mid',   brand: 'Gamma', vip: 'Silver',   jurisdiction: 'MGA',  consent: false, custom: { f1: 'Apple' } },
];
const order = (col, dir) => sortCustomers(customers, col, dir).map(c => c.id).join(',');

describe('sortCustomers', () => {
  test('id sorts numerically, not lexically', () => {
    expect(order('id', 1)).toBe('CUST-1,CUST-2,CUST-10,CUST-30');
    expect(order('id', -1)).toBe('CUST-30,CUST-10,CUST-2,CUST-1');
  });
  test('name is first + last, case-insensitive', () => {
    expect(order('name', 1)).toBe('CUST-2,CUST-1,CUST-30,CUST-10');
  });
  test('vip sorts by tier rank, not alphabet', () => {
    expect(order('vip', 1)).toBe('CUST-2,CUST-1,CUST-30,CUST-10');
    expect(order('vip', -1)).toBe('CUST-10,CUST-30,CUST-1,CUST-2');
  });
  test('consent: yes first ascending, ties by id', () => {
    expect(order('consent', 1)).toBe('CUST-1,CUST-10,CUST-2,CUST-30');
    expect(order('consent', -1)).toBe('CUST-2,CUST-30,CUST-1,CUST-10');
  });
  test('text columns tie-break on id', () => {
    expect(order('brand', 1)).toBe('CUST-2,CUST-1,CUST-10,CUST-30');
  });
  test('blanks stay last in both directions', () => {
    expect(order('username', 1)).toBe('CUST-2,CUST-30,CUST-10,CUST-1');
    expect(order('username', -1)).toBe('CUST-10,CUST-30,CUST-2,CUST-1');
    expect(order('jurisdiction', -1).endsWith('CUST-1')).toBe(true);
  });
  test('custom fields: text sort, missing/empty last', () => {
    expect(order('cf_f1', 1)).toBe('CUST-30,CUST-10,CUST-1,CUST-2');
    expect(order('cf_f1', -1)).toBe('CUST-10,CUST-30,CUST-1,CUST-2');
  });
  test('returns a copy; no column leaves the list untouched', () => {
    const before = customers.map(c => c.id).join(',');
    const sorted = sortCustomers(customers, 'id', 1);
    expect(sorted).not.toBe(customers);
    expect(customers.map(c => c.id).join(',')).toBe(before);
    expect(sortCustomers(customers, null)).toBe(customers);
  });
  test('numeric custom values compare by value (decimals, negatives)', () => {
    const list = ['1.5', '1.25', '-5', '-10', '12'].map((v, i) => ({ id: `C${i}`, custom: { n: v } }));
    expect(sortCustomers(list, 'cf_n', 1).map(c => c.custom.n).join(',')).toBe('-10,-5,1.25,1.5,12');
    expect(sortCustomers(list, 'cf_n', -1).map(c => c.custom.n).join(',')).toBe('12,1.5,1.25,-5,-10');
  });
  test('unknown VIP tier counts as blank', () => {
    const list = [{ id: 'A', vip: 'Mystery' }, { id: 'B', vip: 'Bronze' }];
    expect(sortCustomers(list, 'vip', 1).map(c => c.id).join(',')).toBe('B,A');
    expect(sortCustomers(list, 'vip', -1).map(c => c.id).join(',')).toBe('B,A');
  });
});

test('nextSort cycles asc → desc → off, and restarts on a new column', () => {
  let s = { col: null, dir: 1 };
  s = nextSort(s, 'vip');   expect(s).toEqual({ col: 'vip', dir: 1 });
  s = nextSort(s, 'vip');   expect(s).toEqual({ col: 'vip', dir: -1 });
  s = nextSort(s, 'brand'); expect(s).toEqual({ col: 'brand', dir: 1 });
  s = nextSort(s, 'brand'); s = nextSort(s, 'brand');
  expect(s).toEqual({ col: null, dir: 1 });
});
