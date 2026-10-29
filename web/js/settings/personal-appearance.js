import { SESSION, CURRENT_PAGE, SETTINGS_TAB } from '../core/state.js';
import { apiGet, apiPatch, getJwt, getWorkspaceId } from '../core/api-client.js';
import { renderPage } from '../core/router.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { refreshSidebar } from '../core/sidebar.js';

const defaults = { navigation_position: 'left', colour_scheme: 'violet', display_mode: 'light' };
const positions = ['left', 'top'];
const schemes = ['violet', 'blue', 'teal'];
const modes = ['light', 'dark', 'system'];
const systemTheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
systemTheme?.addEventListener('change', () => { if (state && current(state)) paint(state.draft); });
let state;

function current(s) {
  return state === s && SESSION === s.session && getJwt() === s.jwt && getWorkspaceId() === s.workspace;
}
function paint(value) {
  const app = document.getElementById('app');
  if (!app) return;
  app.dataset.navigation = value.navigation_position;
  app.dataset.colourScheme = value.colour_scheme;
  app.dataset.displayMode = value.display_mode === 'system' ? (systemTheme?.matches ? 'dark' : 'light') : value.display_mode;
  refreshSidebar();
}
function notify() {
  if (CURRENT_PAGE === 'settings' && SETTINGS_TAB === 'display') renderPage('settings');
}
export function resetPersonalAppearance() {
  state = null;
  paint(defaults);
}
export function cancelAppearancePreview() {
  if (!state) return;
  state.draft = { ...state.saved };
  state.error = '';
  paint(state.saved);
}
export function ensurePersonalAppearance() {
  if (state && current(state)) return;
  resetPersonalAppearance();
  const s = state = { session: SESSION, jwt: getJwt(), workspace: getWorkspaceId(), saved: { ...defaults },
    draft: { ...defaults }, ready: false, saving: false, error: '', failed: false };
  if (!SESSION?.userId || !s.jwt || !s.workspace) {
    s.ready = !SESSION?.userId;
    return;
  }
  void load(s);
}
async function load(s) {
  try {
    const { user } = await apiGet('/api/v1/me', { signal: AbortSignal.timeout(10000) });
    if (!current(s)) return;
    if (!positions.includes(user?.navigation_position) || !schemes.includes(user?.colour_scheme)) throw Error();
    if (user.display_mode !== undefined && !modes.includes(user.display_mode)) throw Error();
    s.saved = { navigation_position: user.navigation_position, colour_scheme: user.colour_scheme, display_mode: user.display_mode || 'light' };
    s.draft = { ...s.saved };
    s.ready = true;
    s.failed = false;
    paint(s.saved);
  } catch {
    if (!current(s)) return;
    s.failed = true;
  }
  notify();
}
function changed(s) {
  return Object.keys(defaults).some(key => s.saved[key] !== s.draft[key]);
}
function updateControls() {
  const s = state;
  if (!s) return;
  for (const el of document.querySelectorAll('.personal-appearance input[type="radio"]')) {
    el.checked = s.draft[el.name] === el.value;
  }
  const status = document.getElementById('appearance-status');
  if (status) status.textContent = s.error || (s.saving ? 'Saving…' : changed(s) ? 'Unsaved changes' : 'All changes saved');
  const save = document.getElementById('appearance-save');
  if (save) save.disabled = !s.ready || s.saving || !changed(s);
  const cancel = document.getElementById('appearance-cancel');
  if (cancel) cancel.disabled = s.saving || !changed(s);
}
function select(field, value) {
  const s = state;
  if (!s || !current(s) || !s.ready || s.saving) return;
  if (!({ navigation_position: positions, colour_scheme: schemes, display_mode: modes })[field]?.includes(value)) return;
  s.draft[field] = value;
  s.error = '';
  paint(s.draft);
  updateControls();
}
async function save() {
  const s = state;
  if (!s || !current(s) || !s.ready || s.saving || !changed(s)) return;
  s.saving = true;
  s.error = '';
  const submitted = { ...s.draft };
  notify();
  try {
    if (s.session?.userId) await apiPatch('/api/v1/me', submitted, { signal: AbortSignal.timeout(10000) });
    if (!current(s)) return;
    s.saved = submitted;
    s.draft = { ...submitted };
    paint(s.draft);
  } catch {
    if (!current(s)) return;
    s.error = 'Couldn’t save your appearance. Please try again.';
  } finally {
    if (current(s)) {
      s.saving = false;
      notify();
      document.getElementById('appearance-status')?.focus();
    }
  }
}
const title = value => value[0].toUpperCase() + value.slice(1);
function option(field, value) {
  const layout = field === 'navigation_position';
  return `<label class="appearance-choice"><input type="radio" name="${field}" value="${value}" ${state.draft[field] === value ? 'checked' : ''} ${!state.ready || state.saving ? 'disabled' : ''} data-change-action="appearance.choose"/>
    <span class="appearance-card">${field === 'display_mode' ? '' : `<span class="appearance-mini ${layout ? 'mini-' + value : 'mini-theme theme-' + value}" aria-hidden="true"><i></i><b></b><em></em><span></span></span>`}<span class="appearance-label">${title(value)}<span class="appearance-check" aria-hidden="true">✓</span></span></span></label>`;
}
export function renderPersonalAppearance() {
  ensurePersonalAppearance();
  const s = state;
  return `<section class="personal-appearance settings-section" aria-labelledby="appearance-heading">
    <h2 id="appearance-heading" class="settings-h">Appearance</h2>
    <p class="appearance-intro">Make Respovia feel right for you. These settings only affect your account.</p>
    ${s.failed ? '<p role="alert">Couldn’t load your appearance settings. <button class="btn btn-sm" data-action="appearance.retry">Try again</button></p>' : !s.ready ? '<p role="status">Loading appearance settings…</p>' : ''}
    <fieldset class="appearance-fieldset"><legend>Menu position</legend><div class="appearance-options">${positions.map(v => option('navigation_position', v)).join('')}</div></fieldset>
    <fieldset class="appearance-fieldset"><legend>Colour scheme</legend><div class="appearance-options appearance-schemes">${schemes.map(v => option('colour_scheme', v)).join('')}</div></fieldset>
    <fieldset class="appearance-fieldset"><legend>Light and dark mode</legend><div class="appearance-options appearance-schemes">${modes.map(v => option('display_mode', v)).join('')}</div><p class="appearance-hint">System follows your device’s appearance.</p></fieldset>
    <p class="appearance-hint">Your brand colours, portal and emails stay the same.</p>
    ${!s.session?.userId ? '<p class="appearance-hint">Demo preview only. Sign in to save across devices.</p>' : ''}
    <div class="appearance-footer"><span id="appearance-status" role="status" tabindex="-1">${s.error || (s.saving ? 'Saving…' : !s.ready ? '' : changed(s) ? 'Unsaved changes' : 'All changes saved')}</span>
    <div class="appearance-buttons"><button type="button" class="btn" data-action="appearance.defaults" ${!s.ready || s.saving ? 'disabled' : ''}>Restore defaults</button><button type="button" id="appearance-cancel" class="btn" data-action="appearance.cancel" ${s.saving || !changed(s) ? 'disabled' : ''}>Cancel</button><button type="button" id="appearance-save" class="btn btn-solid" data-action="appearance.save" ${!s.ready || s.saving || !changed(s) ? 'disabled' : ''}>Save changes</button></div></div>
  </section>`;
}
registerChangeActions({ 'appearance.choose': (_, el) => select(el.name, el.value) });
registerActions({
  'appearance.save': save,
  'appearance.cancel': () => { cancelAppearancePreview(); updateControls(); },
  'appearance.defaults': () => { for (const [field, value] of Object.entries(defaults)) select(field, value); },
  'appearance.retry': () => { if (state?.failed) { state.failed = false; void load(state); notify(); } },
});
