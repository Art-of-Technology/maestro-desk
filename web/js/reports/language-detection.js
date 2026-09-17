// Language-detection reliability widget for Insights. The server returns only
// workspace aggregates and stable reason codes; no message text, provider
// output or request identifiers reach this view.

import { apiGet, getJwt, getWorkspaceId } from '../core/api-client.js';
import { renderPage } from '../core/router.js';
import { registerActions } from '../core/event-delegation.js';

let state = { key: null, data: null, loading: false, error: null };

const REASONS = {
  unknown_language: 'Not enough language evidence',
  unsupported_response: 'Unsupported AI response',
  empty_response: 'Empty AI response',
  provider_error: 'AI provider unavailable',
  insufficient_credit: 'AI credit unavailable',
};

function rerender() {
  if (document.body.dataset.currentPage === 'reports') renderPage('reports');
}

async function load(range, key, requestState) {
  requestState.loading = true;
  try {
    const data = await apiGet(`/api/v1/reports/language-detection?range=${encodeURIComponent(range)}`);
    if (state === requestState && state.key === key) state.data = data;
  } catch {
    if (state === requestState && state.key === key) state.error = 'Could not load language-detection reliability.';
  } finally {
    if (state === requestState && state.key === key) state.loading = false;
    rerender();
  }
}

function ensure(range) {
  const key = `${getWorkspaceId()}:${range}`;
  if (state.key !== key) state = { key, data: null, loading: false, error: null };
  if (!state.data && !state.loading && !state.error) void load(range, key, state);
}

function formatBucket(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function pulse(data) {
  const buckets = data.trend || [];
  if (!buckets.length) return '';
  const cells = buckets.map(bucket => {
    const rate = bucket.attempts ? (bucket.failures / bucket.attempts) * 100 : 0;
    const tone = bucket.failures === 0 ? 'ok' : rate < 10 ? 'warn' : 'fail';
    const label = `${formatBucket(bucket.bucket)}: ${bucket.failures} of ${bucket.attempts} failed`;
    return `<span class="detection-pulse-cell ${tone}" title="${window.escAttr(label)}"></span>`;
  }).join('');
  return `<div class="detection-pulse" aria-label="Failure pattern over time">${cells}</div>
    <div class="detection-pulse-axis"><span>${window.escHtml(formatBucket(buckets[0].bucket))}</span><span>${window.escHtml(formatBucket(buckets.at(-1).bucket))}</span></div>`;
}

function reasonRows(data) {
  const reasons = data.reasons || [];
  const max = Math.max(1, ...reasons.map(reason => reason.count));
  if (!reasons.length) return '<p class="detection-empty">No failure reasons in this range.</p>';
  return reasons.map(reason => `<div class="r-bar-row">
    <div class="r-bar-lbl" title="${window.escAttr(REASONS[reason.code] || reason.code)}">${window.escHtml(REASONS[reason.code] || reason.code)}</div>
    <div class="r-bar-track"><div class="r-bar-fill" style="background:var(--red);width:${(reason.count / max) * 100}%"></div></div>
    <div class="r-bar-val">${reason.count}</div>
  </div>`).join('');
}

export function renderLanguageDetectionFailures(range) {
  if (!getJwt()) return `<div class="card"><div class="card-title">Language detection failures</div><p class="detection-empty">Sign in to a live workspace to see detection reliability.</p></div>`;
  ensure(range);
  if (state.error) return `<div class="card"><div class="card-title">Language detection failures</div>
    <p class="detection-empty" role="alert">${window.escHtml(state.error)} <button class="btn btn-sm" data-action="detectionFailures.retry">Retry</button></p></div>`;
  if (!state.data) return `<div class="card"><div class="card-title">Language detection failures</div><p class="detection-empty" role="status">Loading detection reliability…</p></div>`;

  const data = state.data;
  const summary = data.summary;
  if (!summary.attempts) return `<div class="card"><div class="card-title">Language detection failures</div>
    <p class="detection-empty">No recorded language checks in this range. Tracking begins with this release.</p></div>`;
  const tracking = summary.recordingSince ? `Tracked since ${formatBucket(summary.recordingSince)}` : 'Tracking begins with this release';
  return `<div class="card detection-card ${summary.failures ? '' : 'healthy'}"><div class="card-title">Language detection failures</div>
    <div class="detection-summary">
      <div><strong>${summary.failureRate}%</strong><span>failure rate</span></div>
      <div><strong>${summary.failures}</strong><span>failed or unclear</span></div>
      <div><strong>${summary.affectedTickets}</strong><span>affected tickets</span></div>
    </div>
    ${pulse(data)}
    <div class="detection-reasons"><div class="detection-subhead">Recurring reasons</div>${reasonRows(data)}</div>
    <p class="detection-footnote">${summary.successes} of ${summary.attempts} checks identified a supported language · ${window.escHtml(tracking)}${data.trendTruncated ? ' · Trend shows the latest 120 periods' : ''}</p>
  </div>`;
}

registerActions({
  'detectionFailures.retry': () => {
    state = { key: null, data: null, loading: false, error: null };
    rerender();
  },
});
