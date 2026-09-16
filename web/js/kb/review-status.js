export function reviewStatus(article, today = new Date().toISOString().slice(0, 10)) {
  const due = article.review_due_date?.slice(0, 10);
  if (!due) return { label: 'No review date', overdue: false };
  const overdue = due < today;
  return { label: `${overdue ? 'Review overdue' : due === today ? 'Review due today' : 'Review due'} · ${due}`, overdue };
}

export function reviewSummary(article, esc) {
  const status = reviewStatus(article);
  return `<span class="kb-review-status${status.overdue ? ' kb-review-overdue' : ''}">${esc(status.label)}</span><span>Owner: ${esc(article.owner_name || (article.owner_user_id ? 'Unavailable member' : 'Unassigned'))}</span>`;
}
