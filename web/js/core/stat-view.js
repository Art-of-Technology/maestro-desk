import { getStatView, saveStatView, statPreferenceKey, prepareStatView, statSaveStatus, statSaveNeedsRetry, retryStatViews } from './stat-view-preferences.js';
export { getStatView, saveStatView, statPreferenceKey } from './stat-view-preferences.js';
import { registerActions, registerChangeActions } from './event-delegation.js';
import { renderDataChart } from './chart.js';

const labels = { table: 'Table', bar: 'Bar chart', donut: 'Doughnut chart', line: 'Line graph' };
const esc = value => window.escAttr(String(value));
const statusHtml = id => window.escHtml(statSaveStatus(id)) + (statSaveNeedsRetry(id) ? ' <button type="button" class="btn btn-sm" data-action="stat.retry">Retry</button>' : '');

// Switching only hides/shows these views: filters, pagination and focus survive.
export function renderStatView(id, title, headers, rows, { choices = ['bar', 'table'], tableHtml, chartNote = '', ...chartOptions } = {}) {
  prepareStatView(id, choices);
  const selected = getStatView(id, choices);
  return `<section class="stat-view" aria-label="${esc(title)}"><label class="stat-view-control">View as <select class="filter-select" aria-label="${esc(title)}: view as" data-change-action="stat.view" data-stat-id="${esc(id)}" data-stat-scope="${esc(statPreferenceKey(id))}">${choices.map(choice => `<option value="${choice}" ${selected === choice ? 'selected' : ''}>${labels[choice]}</option>`).join('')}</select></label>${choices.map(choice => `<div data-stat-format="${choice}" ${selected === choice ? '' : 'hidden'}>${choice === 'table' && tableHtml ? tableHtml : renderDataChart(headers, rows, choice, chartOptions)}${choice !== 'table' && chartNote ? `<p class="report-note">${window.escHtml(chartNote)}</p>` : ''}</div>`).join('')}<p class="stat-save-status report-note" role="status">${statusHtml(id)}</p></section>`;
}

window.addEventListener?.('respovia:stat-views', () => {
  for (const el of document.querySelectorAll('[data-change-action="stat.view"]')) {
    const { statId, statScope } = el.dataset;
    if (statScope !== statPreferenceKey(statId)) continue;
    const host = el.closest('.stat-view'), panels = [...host.querySelectorAll('[data-stat-format]')];
    el.value = getStatView(statId, panels.map(panel => panel.dataset.statFormat));
    panels.forEach(panel => { panel.hidden = panel.dataset.statFormat !== el.value; });
    host.querySelector('.stat-save-status').innerHTML = statusHtml(statId);
  }
});

registerChangeActions({
  'stat.view': (ds, el) => {
    if (ds.statScope !== statPreferenceKey(ds.statId)) return;
    const host = el.closest('.stat-view');
    const panels = [...host.querySelectorAll('[data-stat-format]')];
    const choices = panels.map(panel => panel.dataset.statFormat);
    if (!choices.includes(el.value)) return;
    const selected = el.value;
    const saved = saveStatView(ds.statId, selected, choices);
    el.value = selected;
    panels.forEach(panel => { panel.hidden = panel.dataset.statFormat !== el.value; });
    host.querySelector('.stat-save-status').textContent = statSaveStatus(ds.statId) || (saved ? '' : 'This view changed, but your browser could not save it for next time.');
  },
});

registerActions({ 'stat.retry': retryStatViews });
