import { articleLink, articleStatus } from './article-state.js';
import { articleMarket } from './bulk-review.js';

export function cardTitle(article) {
  const prefix = `[${articleMarket(article)}] `;
  return articleMarket(article) !== 'unassigned' && article.title.startsWith(prefix)
    ? article.title.slice(prefix.length) : article.title;
}

export function updatedLabel(value) {
  if (!value) return 'Updated time unavailable';
  // Legacy demo dates have no time; do not invent midnight or shift the date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `Updated ${value} · time unavailable`;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Updated time unavailable';
  return 'Updated ' + new Intl.DateTimeFormat(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
}

const PROVIDERS = { pragmatic: 'Pragmatic Play', netent: 'NetEnt', evolution: 'Evolution', redtiger: 'Red Tiger',
  bigtimegaming: 'Big Time Gaming', nolimitcity: 'Nolimit City', pgsoft: 'PG Soft', playngo: 'Play’n GO' };

export function gameDirectory(article) {
  const market = articleMarket(article);
  if (article.category !== `Games · ${market}`) return null;
  const link = articleLink(article.body);
  if (!link) return null;
  const url = new URL(link);
  if (!['spacecasino.com', 'www.spacecasino.com'].includes(url.hostname)) return null;
  const match = /^\/(?:([a-z]{2}(?:-[a-z]{2})?)\/)?games\/([a-z0-9-]+)\/[^/]+\/[^/]+\/?$/.exec(url.pathname);
  if (!match || (match[1] || 'en') !== market) return null;
  const provider = match[2];
  return { key: `${market}/${provider}`, market, provider, title: PROVIDERS[provider] || provider.replace(/-/g, ' ') };
}

export function cardMatchesQuery(article, query) {
  const text = query.toLowerCase().trim();
  return !text || [article.title, article.body, article.category, article.id, gameDirectory(article)?.title]
    .some(value => (value || '').toLowerCase().includes(text));
}

export function directoryCards(articles) {
  const groups = new Map(), cards = [];
  for (const article of articles) {
    const directory = gameDirectory(article);
    if (!directory) { cards.push({ article }); continue; }
    let group = groups.get(directory.key);
    if (!group) {
      group = { ...directory, articles: [], updated: '', counts: { draft: 0, published: 0, archived: 0 } };
      groups.set(directory.key, group);
      cards.push(group);
    }
    group.articles.push(article);
    group.counts[articleStatus(article)]++;
    if ((article.updated || '') > group.updated) group.updated = article.updated;
  }
  for (const group of groups.values()) group.articles.sort((a, b) => cardTitle(a).localeCompare(cardTitle(b)));
  return cards;
}
