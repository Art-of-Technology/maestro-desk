import { test, expect } from 'bun:test';
import { articleMarket, matchingArticles, DraftSelection, publishDrafts } from '../web/js/kb/bulk-review.js';

const make = (id, status = 'draft', category = 'Games · en-ca') => ({ _uuid: id, id, title: `Game ${id}`, body: 'https://example.com/game', category, status });

test('markets use exact import categories and combine with category, status and search', () => {
  const articles = [make('one'), make('two', 'published'), make('three', 'draft', 'Website · en-ca'), make('four', 'draft', 'Games · pt-br'), make('five', 'draft', 'General')];
  expect(articleMarket(articles[4])).toBe('unassigned');
  expect(articleMarket({ category: 'Unrelated · en-ca' })).toBe('unassigned');
  expect(matchingArticles(articles, { market: 'en-ca', status: 'draft' }).map(a => a.id)).toEqual(['one', 'three']);
  expect(matchingArticles(articles, { market: 'en-ca', category: 'Games · en-ca', status: 'draft', query: ' ONE ' }).map(a => a.id)).toEqual(['one']);
  expect(matchingArticles(articles, { market: 'pt-br', query: 'one' })).toEqual([]);
});

test('selection clears on context changes and prunes published, archived and removed articles', () => {
  const selection = new DraftSelection();
  const articles = [make('one'), make('two'), make('three', 'archived')];
  selection.sync('workspace/filter-a', articles);
  selection.ids = new Set(['one', 'two', 'three', 'deleted']);
  articles[1].status = 'published';
  selection.sync('workspace/filter-a', articles);
  expect([...selection.ids]).toEqual(['one']);
  selection.sync('workspace/filter-b', articles);
  expect(selection.ids.size).toBe(0);
  selection.ids.add('one');
  selection.sync('other-workspace/filter-b', articles);
  expect(selection.ids.size).toBe(0);
  selection.ids.add('one');
  selection.sync('other-workspace/filter-b', articles.map(a => ({ ...a })));
  expect(selection.ids.size).toBe(0);
});

test('partial failures preserve drafts, successes apply once, published and archived are skipped', async () => {
  const articles = [make('one'), make('two'), make('three', 'published'), make('four', 'archived')];
  const calls = [], progress = [];
  const options = {
    active: () => true,
    publish: async a => { calls.push(a.id); if (a.id === 'two') throw new Error('Offline'); return { article: { status: 'published' } }; },
    onSuccess: (a, response) => { a.status = response.status; },
    onProgress: r => progress.push(r.published),
  };
  const result = await publishDrafts(articles, options);
  expect(calls).toEqual(['one', 'two']);
  expect(result.published).toBe(1);
  expect(result.failures[0].article.id).toBe('two');
  expect(articles[1].status).toBe('draft');
  expect(progress).toEqual([1, 1]);
  calls.length = 0;
  await publishDrafts(articles, options);
  expect(calls).toEqual(['two']);
});

test('session change discards a late response and stops before the next request', async () => {
  let active = true;
  const calls = [], applied = [];
  const result = await publishDrafts([make('one'), make('two')], {
    active: () => active,
    publish: async a => { calls.push(a.id); active = false; return { article: { status: 'published' } }; },
    onSuccess: a => applied.push(a.id), onProgress() {},
  });
  expect(calls).toEqual(['one']);
  expect(applied).toEqual([]);
  expect(result.stopped).toBe(true);
});

test('stop preserves the in-flight success and leaves remaining drafts untouched', async () => {
  let keepGoing = true;
  const articles = [make('one'), make('two')];
  const result = await publishDrafts(articles, {
    active: () => true, shouldContinue: () => keepGoing,
    publish: async () => { keepGoing = false; return { article: { status: 'published' } }; },
    onSuccess: (a, response) => { a.status = response.status; }, onProgress() {},
  });
  expect(result.published).toBe(1);
  expect(result.stopped).toBe(true);
  expect(articles[1].status).toBe('draft');
});
