import { test, expect } from 'bun:test';
import { reviewStatus, reviewSummary } from '../web/js/kb/review-status.js';

test('review dates use calendar days with a distinct due today state', () => {
  expect(reviewStatus({}, '2026-09-16')).toEqual({label:'No review date',overdue:false});
  expect(reviewStatus({review_due_date:'2026-09-15'}, '2026-09-16').overdue).toBe(true);
  expect(reviewStatus({review_due_date:'2026-09-16'}, '2026-09-16')).toEqual({label:'Review due today · 2026-09-16',overdue:false});
  expect(reviewStatus({review_due_date:'2026-09-17'}, '2026-09-16').overdue).toBe(false);
});
test('missing and removed owners remain explicit and names are escaped', () => {
  const esc = value => value.replaceAll('<','&lt;');
  expect(reviewSummary({}, esc)).toContain('Unassigned');
  expect(reviewSummary({owner_user_id:'removed'}, esc)).toContain('Unavailable member');
  expect(reviewSummary({owner_name:'<owner>'}, esc)).toContain('&lt;owner>');
});
