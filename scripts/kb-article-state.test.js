import { test, expect } from 'bun:test';
import { articleStatus, articleLink } from '../web/js/kb/article-state.js';

test('unknown server status awaits review while legacy demo articles remain published', () => {
  expect(articleStatus({ _uuid: 'server-id' })).toBe('draft');
  expect(articleStatus({ status: 'unexpected' })).toBe('draft');
  expect(articleStatus({ status: 'draft' })).toBe('draft');
  expect(articleStatus({ status: 'archived' })).toBe('archived');
  expect(articleStatus({ status: 'published' })).toBe('published');
  expect(articleStatus({})).toBe('published');
});

test('only a standalone web URL becomes a clickable link article', () => {
  const url = 'https://www.spacecasino.com/en-ca/games/netent/monopoly-money-line/5224';
  expect(articleLink('  ' + url + '\n')).toBe(url);
  for (const body of ['javascript:alert(1)', 'data:text/html,test', 'https://', 'https://user:password@example.com', url + '\nNotes', '<a href="https://example.com">test</a>']) {
    expect(articleLink(body)).toBeNull();
  }
});
