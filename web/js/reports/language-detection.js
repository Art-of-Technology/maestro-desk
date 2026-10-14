// Language-detection reliability widget for Insights. The server returns only
// workspace aggregates and stable reason codes; no message text, provider
// output or request identifiers reach this view.

import { apiGet, getJwt, getWorkspaceId } from '../core/api-client.js';
import { renderPage } from '../core/router.js';
import { renderStatView } from '../core/stat-view.js';
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
  return renderStatView('detection-trend', 'Language detection over time', ['Period starting', 'Successful', 'Failed or unclear'], (data.trend || []).map(b => [formatBucket(b.bucket), b.attempts - b.failures, b.failures]), { choices: ['line', 'bar', 'table'], colorFor: (_label, i) => i ? 'var(--red)' : 'var(--green)' });
}

function reasonRows(data) {
  return renderStatView('detection-reasons', 'Language detection failure reasons', ['Reason', 'Failures'], (data.reasons || []).map(r => [REASONS[r.code] || r.code, r.count]), { colorFor: () => 'var(--red)' });
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
