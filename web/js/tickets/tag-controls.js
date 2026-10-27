import { TAG_LIBRARY } from '../core/data.js';
import { apiGet, getJwt, getWorkspaceId } from '../core/api-client.js';
import { callClaude } from '../ai/client.js';
import { can } from '../core/permissions.js';

const views = new WeakMap();
export function availableTags(applied = [], query = '') {
  return TAG_LIBRARY.filter(t => !applied.includes(t.tag) && t.tag.toLowerCase().includes(query.toLowerCase()));
}
export function validSuggestions(names, applied = []) {
  const allowed = new Set(availableTags(applied).map(t => t.tag));
  return [...new Set(Array.isArray(names) ? names : [])].filter(t => allowed.has(t)).slice(0, 3);
}
export function renderTagControls(id) {
  return `<div class="ticket-tag-controls" id="tag-controls-${window.escAttr(id)}"><div class="ticket-tag-list" data-applied></div><details class="tag-picker"><summary class="btn btn-sm">Add tag</summary><label>Find a tag<input type="search" class="form-input" data-tag-search autocomplete="off"></label><div data-tag-options></div></details><div class="tag-suggestions" data-suggestions aria-live="polite"></div></div>`;
}
export function mountTagControls(model, context, add, remove) {
  const host = document.getElementById('tag-controls-' + model.id);
  if (!host || !host.querySelector('[data-tag-search]')) return;
  const previous = views.get(model);
  if (previous) clearTimeout(previous.timer);
  const jwt = getJwt(), workspace = getWorkspaceId();
  const active = () => host.isConnected && jwt === getJwt() && workspace === getWorkspaceId() && views.get(model) === view;
  const view = { host, timer: null, schedule };
  views.set(model, view);
  model.tagSuggestions ||= { names: [], key: null };
  const state = model.tagSuggestions;
  const editable = () => can('tickets.edit') && !model.busy;
  host.querySelector('details').hidden = !editable();
  let busy = false;
  const applied = host.querySelector('[data-applied]'), options = host.querySelector('[data-tag-options]'), suggestions = host.querySelector('[data-suggestions]');
  function draw() {
    if (!active()) return;
    const focused = host.contains?.(document.activeElement) ? document.activeElement?.dataset : null;
    const button = (tag, action, label) => `<button type="button" class="btn btn-sm" data-tag-operation="${action}" data-tag="${window.escAttr(tag)}" aria-label="${window.escAttr(label + ' ' + tag)}"${busy || !editable() ? ' disabled' : ''}>${window.escHtml(tag)}${action === 'remove' ? ' ×' : ''}</button>`;
    applied.innerHTML = (model.tags || []).map(tag => button(tag, 'remove', 'Remove tag')).join('');
    const choices = availableTags(model.tags, host.querySelector('[data-tag-search]').value);
    options.innerHTML = choices.map(t => button(t.tag, 'add', 'Add tag')).join('') || `<p>${TAG_LIBRARY.length ? 'No available tags match.' : 'No tags yet. Ask an admin to add tags in Settings.'}</p>`;
    suggestions.innerHTML = '<span>Suggested tags</span> ' + (state.loading ? '<span>Finding matches…</span>' : validSuggestions(state.names, model.tags).map(tag => button(tag, 'add', 'Add suggested tag')).join('')) + (state.error ? `<span role="alert">${window.escHtml(state.error)}</span> <button type="button" class="btn btn-sm" data-tag-operation="retry">Retry</button>` : '') + (!state.loading && state.key && !state.error && !validSuggestions(state.names, model.tags).length ? '<span>No matching tags.</span>' : '');
    suggestions.hidden = !jwt || !can('tools.ai') || !TAG_LIBRARY.length;
    if (focused?.tagOperation) {
      const target = [...host.querySelectorAll('[data-tag-operation]')].find(el => !el.disabled && el.dataset.tagOperation === focused.tagOperation && el.dataset.tag === focused.tag);
      (target || host.querySelector('summary')).focus({ preventScroll: true });
    }
  }
  async function generate() {
    if (!active() || !jwt || !can('tools.ai') || !TAG_LIBRARY.length) return;
    const content = context();
    if (!content.trim()) return;
    const key = JSON.stringify([workspace, content, TAG_LIBRARY.map(t => t.tag), model.tags || []]);
    if (state.key === key) { draw(); return; }
    if (state.loading) { schedule(); return; }
    state.key = key; state.loading = true; state.error = ''; state.names = []; draw();
    try {
      const result = await callClaude({ action: 'tag_suggestions', model: 'claude-haiku-4-5', ticketId: model._uuid, maxTokens: 256, messages: [{ role: 'user', content: content.slice(-50000) + '\nAlready applied tags: ' + JSON.stringify(model.tags || []) }] });
      if (workspace !== getWorkspaceId() || jwt !== getJwt() || model.tagSuggestions !== state) return;
      if (content !== context()) { state.key = null; return; }
      state.names = validSuggestions(JSON.parse(result.text), model.tags);
    } catch (err) {
      if (!active()) return;
      state.error = err.status === 402 ? 'No AI credit available.' : 'Suggestions unavailable. You can still choose a tag.';
    } finally {
      state.loading = false;
      if (active()) draw();
      if (model.tagSuggestions === state && content !== context()) views.get(model)?.schedule();
    }
  }
  function schedule() { clearTimeout(view.timer); view.timer = setTimeout(generate, 1800); }
  host.querySelector('[data-tag-search]').oninput = draw;
  host.onkeydown = event => {
    if (event.key === 'Escape' && host.querySelector('details').open) {
      event.preventDefault(); event.stopPropagation();
      host.querySelector('details').open = false;
      host.querySelector('summary').focus();
    }
  };
  host.querySelector('details').ontoggle = async event => {
    if (!event.target.open || !jwt) return;
    try {
      const response = await apiGet('/api/v1/tags');
      if (!active()) return;
      TAG_LIBRARY.splice(0, TAG_LIBRARY.length, ...response.tags.map(t => ({ tag: t.tag, count: t.count, type: t.kind, conf: t.ai_confidence })));
      draw(); schedule();
    } catch { if (active()) options.textContent = 'Could not load tags. Close and reopen to retry.'; }
  };
  host.onclick = async event => {
    const button = event.target.closest('[data-tag-operation]');
    if (!button || busy || !active() || !editable()) return;
    if (button.dataset.tagOperation === 'retry') { state.key = null; void generate(); return; }
    const tag = button.dataset.tag;
    if (button.dataset.tagOperation === 'add' && !availableTags(model.tags).some(t => t.tag === tag)) return;
    busy = true; draw();
    try {
      await (button.dataset.tagOperation === 'remove' ? remove(tag) : add(tag));
      if (active()) { host.querySelector('details').open = false; schedule(); }
    } catch (err) { if (active()) state.error = err.message || 'Could not save the tag.'; }
    finally {
      busy = false; draw();
      if (jwt === getJwt() && workspace === getWorkspaceId()) document.getElementById('tag-controls-' + model.id)?.querySelector('summary')?.focus({ preventScroll: true });
    }
  };
  draw(); schedule();
}
export function scheduleTagSuggestions(model) { views.get(model)?.schedule(); }
