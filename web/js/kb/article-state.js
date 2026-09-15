// Unknown server states stay out of the published view; demo articles predate status.
export function articleStatus(article) {
  if (article.status === 'published' || article.status === 'archived') return article.status;
  if (!article.status && !article._uuid) return 'published';
  return 'draft';
}

export const ARTICLE_STATUS_LABELS = {
  draft: 'Awaiting review',
  published: 'Published',
  archived: 'Archived',
};

export function articleLink(body) {
  const text = (body || '').trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.username || url.password ? null : url.href;
  } catch {
    return null;
  }
}
