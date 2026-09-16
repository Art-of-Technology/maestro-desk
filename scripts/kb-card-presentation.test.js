import { test, expect } from 'bun:test';
import { cardTitle, updatedLabel, gameDirectory, directoryCards, cardMatchesQuery, articleCategory, articlePreview, articlePage } from '../web/js/kb/card-presentation.js';

test('display categories separate recognised markets and preserve custom categories',()=>{
  expect(articleCategory({category:'Website · es-mx'})).toBe('Website');
  expect(articleCategory({category:'Games · en'})).toBe('Games');
  expect(articleCategory({category:'Payments · VIP'})).toBe('Payments · VIP');
});

test('previews omit import metadata without modifying article content',()=>{
  const a={body:'Source URL: https://example.test\r\nRequested URL: https://example.test\nLanguage / market: en\nRetrieved: today\n\n## Withdrawals\nUse [your account](https://example.test/account) to request a withdrawal.'};
  const original=a.body;
  expect(articlePreview(a)).toBe('Withdrawals Use your account to request a withdrawal.');
  expect(a.body).toBe(original);
  expect(articlePreview({body:'The source URL is useful.\nNormal policy text.'})).toContain('The source URL is useful.');
});

test('pagination clamps empty and shrinking lists without splitting directories',()=>{
  const entries=Array.from({length:101},(_,i)=>({article:{id:i}}));
  const first=articlePage(entries,0), second=articlePage(entries,1), last=articlePage(entries,99);
  expect(first.entries).toHaveLength(50);expect(second.first).toBe(51);expect(last.first).toBe(101);expect(last.entries).toHaveLength(1);
  expect(articlePage([],4)).toMatchObject({page:0,pages:1,first:0,last:0});
  expect(articlePage(entries,NaN).page).toBe(0);
  const grouped=directoryCards([game('a'),game('b')]);
  expect(articlePage(grouped,0).entries[0].articles).toHaveLength(2);
});

const game = (id, market = 'en-ca', provider = 'netent', status = 'draft') => ({
  id, _uuid: id, title: `[${market}] Game ${id}`, category: `Games · ${market}`, status,
  body: `https://www.spacecasino.com/${market}/games/${provider}/game-${id}/123`, updated: '2026-09-15T09:30:00Z',
});

test('removes only the matching displayed locale prefix', () => {
  expect(cardTitle(game('a'))).toBe('Game a');
  expect(cardTitle({ ...game('a'), title: '[pt-br] Game a' })).toBe('[pt-br] Game a');
  expect(cardTitle({ ...game('a'), category: 'General' })).toBe('[en-ca] Game a');
});

test('groups by market and provider without changing links or mixed statuses', () => {
  const a = game('a'), b = { ...game('b', 'en-ca', 'netent', 'published'), updated: '2026-09-15T10:31:00Z' };
  const list = [a, b, game('c', 'en-nz'), game('d', 'en-ca', 'pragmatic')];
  const original = JSON.stringify(list);
  const groups = directoryCards(list);
  expect(groups).toHaveLength(3);
  expect(groups[0].title).toBe('NetEnt');
  expect(groups[0].articles).toEqual([a, b]);
  expect(groups[0].counts).toEqual({ draft: 1, published: 1, archived: 0 });
  expect(groups[0].updated).toBe(b.updated);
  expect(JSON.stringify(list)).toBe(original);
});

test('keeps malformed, unrelated and mismatched market links as individual cards', () => {
  for (const body of ['https://evil.example/en-ca/games/netent/a/1', 'https://www.spacecasino.com/pt-br/games/netent/a/1', 'https://www.spacecasino.com/en-ca/games/netent/a/1\nNotes']) {
    const a = { ...game('a'), body };
    expect(gameDirectory(a)).toBeNull();
    expect(directoryCards([a])[0].article).toBe(a);
  }
  expect(gameDirectory({ ...game('a', 'en'), body: 'https://www.spacecasino.com/games/netent/a/1' })?.market).toBe('en');
});

test('formats full timestamps and does not invent times for old or missing dates', () => {
  expect(updatedLabel('2026-09-15T09:30:00Z')).toContain('2026');
  expect(updatedLabel('2026-09-15T09:30:00Z')).not.toContain('unavailable');
  expect(updatedLabel('2026-09-15')).toBe('Updated 2026-09-15 · time unavailable');
  expect(updatedLabel('bad')).toBe('Updated time unavailable');
  expect(updatedLabel('')).toBe('Updated time unavailable');
});

test('search finds displayed provider names as well as game titles', () => {
  expect(cardMatchesQuery(game('a', 'en-ca', 'pragmatic'), 'Pragmatic Play')).toBe(true);
  expect(cardMatchesQuery(game('a'), 'Game a')).toBe(true);
  expect(cardMatchesQuery(game('a'), 'Pragmatic Play')).toBe(false);
});
