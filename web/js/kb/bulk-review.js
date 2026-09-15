import { articleStatus } from './article-state.js';

// Imported categories carry the locale; ordinary articles remain unassigned.
export function articleMarket(article) {
  return /^(?:Games|Website) · ([a-z]{2}(?:-[a-z]{2})?)$/.exec(article.category || '')?.[1] || 'unassigned';
}

export function matchingArticles(articles, { category = 'all', market = 'all', status = 'all', query = '' } = {}) {
  const q = query.toLowerCase().trim();
  return articles.filter(a => (category === 'all' || a.category === category)
    && (market === 'all' || articleMarket(a) === market)
    && (status === 'all' || articleStatus(a) === status)
    && (!q || [a.title, a.body, a.category, a.id].some(v => (v || '').toLowerCase().includes(q))));
}

export class DraftSelection {
  ids = new Set();
  scope = null;
  references = new Map();
  sync(scope, articles) {
    if (this.scope !== scope) this.ids.clear();
    this.scope = scope;
    const eligible = new Map(articles.filter(a => a._uuid && articleStatus(a) === 'draft').map(a => [a._uuid, a]));
    for (const id of this.ids) if (!eligible.has(id) || this.references.get(id) !== eligible.get(id)) this.ids.delete(id);
    this.references = eligible;
  }
  selected(articles) { return articles.filter(a => this.ids.has(a._uuid) && articleStatus(a) === 'draft'); }
}

// Sequential requests avoid flooding the API. A changed session stops the queue
// and prevents a late response from being applied to another workspace.
export async function publishDrafts(articles, { active, shouldContinue = () => true, publish, onSuccess, onProgress }) {
  const result = { published: 0, failures: [], stopped: false };
  for (const article of articles) {
    if (!active() || !shouldContinue()) { result.stopped = true; break; }
    if (!article._uuid || articleStatus(article) !== 'draft') continue;
    try {
      const response = await publish(article);
      if (!active()) { result.stopped = true; break; }
      if (response.article?.status !== 'published') throw new Error('Publishing was not confirmed.');
      onSuccess(article, response.article);
      result.published++;
    } catch (error) {
      if (!active()) { result.stopped = true; break; }
      result.failures.push({ article, message: error?.message || 'Publishing failed.' });
    }
    onProgress(result);
  }
  return result;
}
