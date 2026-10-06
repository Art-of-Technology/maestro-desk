import { SESSION } from './state.js';
import { getWorkspaceId } from './api-client.js';
import { registerChangeActions } from './event-delegation.js';
import { renderDataChart } from './chart.js';

const labels = { table: 'Table', bar: 'Bar chart', donut: 'Doughnut chart', line: 'Line graph' };
const unsaved = new Map();
const esc = value => window.escAttr(String(value));

export function statPreferenceKey(id) {
  return 'respovia:stat-view:' + JSON.stringify([SESSION?.userId || `demo:${SESSION?.role || ''}:${SESSION?.name || ''}`, getWorkspaceId() || 'demo', id]);
}

export function getStatView(id, choices) {
  const key = statPreferenceKey(id);
  let value = unsaved.get(key);
  if (!value) { try { value = localStorage.getItem(key); } catch {} }
  return choices.includes(value) ? value : choices[0];
}

export function saveStatView(id, value, choices) {
  if (!choices.includes(value) || !Object.hasOwn(labels, value)) return false;
  const key = statPreferenceKey(id);
  try { localStorage.setItem(key, value); unsaved.delete(key); return true; }
  catch { unsaved.set(key, value); return false; }
}

// Switching only hides/shows these views: filters, pagination and focus survive.
export function renderStatView(id, title, headers, rows, { choices = ['bar', 'table'], tableHtml, chartNote = '', ...chartOptions } = {}) {
  const selected = getStatView(id, choices);
  return `<section class="stat-view" aria-label="${esc(title)}"><label class="stat-view-control">View as <select class="filter-select" aria-label="${esc(title)}: view as" data-change-action="stat.view" data-stat-id="${esc(id)}" data-stat-scope="${esc(statPreferenceKey(id))}">${choices.map(choice => `<option value="${choice}" ${selected === choice ? 'selected' : ''}>${labels[choice]}</option>`).join('')}</select></label>${choices.map(choice => `<div data-stat-format="${choice}" ${selected === choice ? '' : 'hidden'}>${choice === 'table' && tableHtml ? tableHtml : renderDataChart(headers, rows, choice, chartOptions)}${choice !== 'table' && chartNote ? `<p class="report-note">${window.escHtml(chartNote)}</p>` : ''}</div>`).join('')}<p class="stat-save-status report-note" role="status"></p></section>`;
}

registerChangeActions({
  'stat.view': (ds, el) => {
    if (ds.statScope !== statPreferenceKey(ds.statId)) return;
    const host = el.closest('.stat-view');
    const panels = [...host.querySelectorAll('[data-stat-format]')];
    const choices = panels.map(panel => panel.dataset.statFormat);
    if (!choices.includes(el.value)) return;
    const saved = saveStatView(ds.statId, el.value, choices);
    panels.forEach(panel => { panel.hidden = panel.dataset.statFormat !== el.value; });
    host.querySelector('.stat-save-status').textContent = saved ? '' : 'This view changed, but your browser could not save it for next time.';
  },
});
