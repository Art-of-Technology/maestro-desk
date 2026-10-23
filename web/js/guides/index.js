import { CURRENT_PAGE, SESSION } from '../core/state.js';
import { getWorkspaceId } from '../core/api-client.js';
import { can, canViewTickets } from '../core/permissions.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { GUIDE_STEPS, GUIDE_MODULES, GUIDE_VERSION } from './config.js';

let navigate = null;
let active = null;
let returnFocus = null;
let scope = null;
let storageAvailable = true;
const memory = new Map();
const inerted = new Map();
const esc = text => window.escHtml(text);
const container = () => document.getElementById('guide-container');
const storageKey = () => `respovia_guides:${getWorkspaceId() || 'demo'}:${SESSION?.userId || SESSION?.name || 'user'}`;
const allowed = item => (!item.adminOnly || (SESSION?.isAdmin ?? window.isAdmin?.()) === true)
  && (!item.permissions || item.permissions.every(can))
  && (!item.anyPermissions || item.anyPermissions.some(can));
const stepsFor = module => GUIDE_STEPS.filter(step => module.stepIds.includes(step.id)
  && allowed(step) && (step.page !== 'tickets' || canViewTickets())
  && (step.page !== 'customers' || can('customers.view')));
const modulesFor = () => GUIDE_MODULES.filter(module => stepsFor(module).length);
const practiceFor = module => module.practice.filter(item => stepsFor(module).some(step => step.id === item.step));
const signature = module => JSON.stringify([stepsFor(module).map(step => step.id), practiceFor(module).map(item => item.id)]);
const emptyProgress = () => ({ version: GUIDE_VERSION, viewed: [], checked: [], practiced: {}, resume: null, started: false });

function readProgress() {
  const key = storageKey();
  if (memory.has(key)) { storageAvailable = false; return memory.get(key); }
  try {
    const raw = localStorage.getItem(key);
    storageAvailable = true;
    if (raw === null) return emptyProgress();
    let data;
    try { data = JSON.parse(raw); } catch { return emptyProgress(); }
    if (data?.version === GUIDE_VERSION && Array.isArray(data.viewed) && Array.isArray(data.checked)
      && data.practiced && typeof data.practiced === 'object' && !Array.isArray(data.practiced)) {
      return { ...emptyProgress(), ...data,
        started: data.started === true,
        viewed: data.viewed.filter(id => GUIDE_STEPS.some(step => step.id === id)),
        checked: data.checked.filter(id => typeof id === 'string'),
        resume: validResume(data.resume) ? data.resume : null,
      };
    }
    return emptyProgress();
  } catch { storageAvailable = false; }
  return emptyProgress();
}

function validResume(value) {
  return value && typeof value.full === 'boolean' && typeof value.practice === 'boolean'
    && GUIDE_MODULES.some(module => module.id === value.moduleId && (value.practice || module.stepIds.includes(value.stepId)));
}

function saveProgress(progress) {
  try { localStorage.setItem(storageKey(), JSON.stringify(progress)); memory.delete(storageKey()); storageAvailable = true; }
  catch { memory.set(storageKey(), progress); storageAvailable = false; }
}

function lockBackground() {
  for (const sibling of container()?.parentElement?.children || []) {
    if (sibling === container() || inerted.has(sibling)) continue;
    inerted.set(sibling, sibling.inert); sibling.inert = true;
  }
}

function sameScope() {
  if (scope === storageKey()) return true;
  closeGuides(false);
  return false;
}

export function initGuides(nav) { navigate = nav; }
export function maybeStartGuides() {
  if (CURRENT_PAGE === 'dashboard' && !readProgress().started) startModule(modulesFor()[0]?.id, true);
}
export function guidePageRendered(page) {
  if (!container()?.firstElementChild || !sameScope()) return;
  if (active && !currentStepAllowed()) return openGuideMenu(false);
  if (active?.practice || (active && currentStep()?.page === page)) render();
}
export function closeGuides(remember = true) {
  // Navigation saves the resume point. Exit never records a step or practice as complete.
  if (remember && active && scope === storageKey()) {
    const progress = readProgress(); progress.resume = { ...active }; saveProgress(progress);
  }
  active = null;
  scope = null;
  if (container()) container().innerHTML = '';
  for (const [element, wasInert] of inerted) element.inert = wasInert;
  inerted.clear();
  if (returnFocus?.isConnected) returnFocus.focus();
}

const currentModule = () => GUIDE_MODULES.find(module => module.id === active?.moduleId);
const currentStep = () => GUIDE_STEPS.find(step => step.id === active?.stepId);
function currentStepAllowed() {
  const module = currentModule();
  return !!module && stepsFor(module).length > 0 && (active.practice || stepsFor(module).some(step => step.id === active.stepId));
}

function startModule(id, full = false, resume = null) {
  const module = modulesFor().find(item => item.id === id);
  if (!module || !container()) return;
  if (!container().firstElementChild) returnFocus = document.activeElement;
  scope = storageKey();
  lockBackground();
  active = resume && validResume(resume) ? { ...resume } : { moduleId: id, stepId: stepsFor(module)[0].id, full, practice: false };
  if (!currentStepAllowed()) active = { moduleId: id, stepId: stepsFor(module)[0].id, full, practice: false };
  const progress = readProgress(); progress.started = true; progress.resume = { ...active }; saveProgress(progress);
  show();
}

function show() {
  if (!sameScope()) return;
  if (!currentStepAllowed()) return openGuideMenu(false);
  const progress = readProgress(); progress.resume = { ...active }; saveProgress(progress);
  if (active.practice || CURRENT_PAGE === currentStep().page) render();
  else {
    render(false);
    navigate?.(currentStep().page);
  }
}

function move(offset) {
  if (!sameScope() || !active) return;
  if (!currentStepAllowed()) return openGuideMenu(false);
  const steps = stepsFor(currentModule());
  if (active.practice) {
    if (offset < 0) { active.practice = false; active.stepId = steps.at(-1).id; show(); }
    return;
  }
  const index = steps.findIndex(step => step.id === active.stepId);
  if (offset > 0 && document.querySelector(`[data-guide="${currentStep().target || active.stepId}"]`)
    && container()?.querySelector('[data-guide-ready]')) {
    const progress = readProgress();
    progress.viewed = [...new Set([...progress.viewed, active.stepId])]; saveProgress(progress);
  }
  if (index + offset < 0) return;
  if (index + offset >= steps.length) active.practice = true;
  else active.stepId = steps[index + offset].id;
  show();
}

function notice() {
  return storageAvailable ? 'Progress saved in this browser for your account and workspace.'
    : 'Browser storage is unavailable. Progress is kept for this open session only.';
}

function render(ready = true) {
  if (!active || !sameScope()) return;
  if (!currentStepAllowed()) return openGuideMenu(false);
  if (active.practice) return renderPractice();
  const step = currentStep();
  const steps = stepsFor(currentModule());
  const index = steps.findIndex(item => item.id === step.id);
  const target = ready ? document.querySelector(`[data-guide="${step.target || step.id}"]`) : null;
  target?.scrollIntoView?.({ block: 'nearest' });
  container().innerHTML = `<div class="guide-layer${target ? '' : ' guide-menu-layer'}">
    ${target ? '<div class="guide-spotlight" aria-hidden="true"></div>' : ''}
    <section class="guide-card${target ? '' : ' guide-unanchored'}" role="dialog" aria-modal="true" aria-labelledby="guide-title" aria-describedby="guide-copy" tabindex="-1" ${target ? 'data-guide-ready' : ''}>
      <div class="guide-meta"><span>${esc(currentModule().title)} · ${index + 1} OF ${steps.length}</span><button type="button" data-action="guides.close">Exit</button></div>
      <h2 id="guide-title">${esc(step.title)}</h2><p id="guide-copy">${esc(step.body)}</p>
      <div class="guide-content" tabindex="0" aria-label="Instructions">
        ${!target ? '<p class="guide-warning" role="status">This area is not available on the current screen. You can skip this step and return later. Skipping does not mark it viewed.</p>' : ''}
        <ol class="guide-highlights">${step.highlights.map(text => `<li>${esc(text)}</li>`).join('')}</ol>
        <details class="guide-details"><summary>More detail</summary><ol class="guide-instructions">${step.instructions.map(text => `<li>${esc(text)}</li>`).join('')}</ol></details>
        <p class="guide-save-note">${notice()}</p>
      </div>
      <div class="guide-foot"><button type="button" class="btn" data-action="guides.back" ${index === 0 ? 'disabled' : ''}>← Back</button><span class="guide-progress">${index + 1} / ${steps.length}</span><button type="button" class="btn btn-solid" data-action="guides.next">${target ? 'Next →' : 'Skip →'}</button></div>
      <button type="button" class="guide-text-button" data-action="guides.open">All modules</button>
    </section></div>`;
  requestAnimationFrame(() => { if (target) positionStep(target); else focusSurface(); });
}

function renderPractice() {
  const module = currentModule();
  const progress = readProgress();
  const practice = practiceFor(module);
  const viewed = stepsFor(module).every(step => progress.viewed.includes(step.id));
  const checked = practice.every(item => progress.checked.includes(`${module.id}:${item.id}`));
  const confirmed = progress.practiced[module.id] === signature(module);
  container().innerHTML = `<div class="guide-layer guide-menu-layer"><section class="guide-menu" role="dialog" aria-modal="true" aria-labelledby="guide-menu-title" tabindex="-1">
    <div class="guide-menu-head"><div><div class="guide-kicker">PRACTICE CHECKLIST</div><h2 id="guide-menu-title">${esc(module.title)}</h2></div><button type="button" class="modal-close" data-action="guides.close" aria-label="Exit and keep progress">×</button></div>
    <p>Exit to practise on work approved by your team. Reopen Guides and choose Resume, tick each result you checked, then Confirm practice. Guides never perform these actions for you.</p>
    <div class="guide-practice">${practice.map(item => `<label><input type="checkbox" data-change-action="guides.check" data-item="${item.id}" ${progress.checked.includes(`${module.id}:${item.id}`) ? 'checked' : ''}><span>${esc(item.task)}<small><strong>Expected result:</strong> ${esc(item.expected)}</small></span></label>`).join('')}</div>
    ${!viewed ? '<p class="guide-warning">Some steps have not been viewed. Review them before confirming practice.</p>' : ''}
    ${confirmed ? '<p class="guide-complete" role="status">✓ Practice confirmed by you</p>' : ''}
    <p class="guide-save-note">${notice()}</p>
    <div class="guide-practice-actions"><button type="button" class="btn" data-action="guides.close">Exit to practise</button><button type="button" class="btn btn-solid" data-action="guides.confirm" ${!viewed || !checked ? 'disabled' : ''}>Confirm practice</button>
    <button type="button" class="btn" data-action="guides.back">Review steps</button><button type="button" class="btn" data-action="guides.continue">${active.full ? 'Continue onboarding →' : 'All modules'}</button></div>
    </section></div>`;
  requestAnimationFrame(focusSurface);
}

function confirmPractice() {
  if (!sameScope() || !active?.practice || !currentStepAllowed()) return;
  const progress = readProgress(); const module = currentModule();
  if (!stepsFor(module).every(step => progress.viewed.includes(step.id))
    || !practiceFor(module).every(item => progress.checked.includes(`${module.id}:${item.id}`))) return;
  progress.practiced[module.id] = signature(module); saveProgress(progress); renderPractice();
}

function continueOnboarding() {
  if (!sameScope() || !active?.practice || !currentStepAllowed()) return;
  const modules = modulesFor();
  const next = modules[modules.findIndex(module => module.id === active.moduleId) + 1];
  if (active.full && next) return startModule(next.id, true);
  const progress = readProgress(); progress.resume = null; saveProgress(progress);
  openGuideMenu(false);
}

function openGuideMenu(captureFocus = true) {
  if (captureFocus && !container()?.firstElementChild) returnFocus = document.activeElement;
  scope = storageKey(); active = null; lockBackground();
  const host = container(); if (!host) return;
  const progress = readProgress(); const modules = modulesFor();
  const resume = progress.resume && modules.find(module => module.id === progress.resume.moduleId);
  host.innerHTML = `<div class="guide-layer guide-menu-layer" data-action="guides.closeMenu"><section class="guide-menu" role="dialog" aria-modal="true" aria-labelledby="guide-menu-title" data-action="" tabindex="-1">
    <div class="guide-menu-head"><div><div class="guide-kicker">GUIDED LEARNING</div><h2 id="guide-menu-title">Learn Respovia</h2></div><button type="button" class="modal-close" data-action="guides.closeMenu" aria-label="Close">×</button></div>
    <p>Modules follow your saved permissions. Viewed steps and practice you confirm are tracked separately.</p>
    ${resume ? '<button type="button" class="btn btn-solid guide-start" data-action="guides.resume">Resume where you left off →</button>' : ''}
    <button type="button" class="btn guide-start" data-action="guides.quickStart">Start full onboarding · ${modules.length} modules</button>
    <div class="guide-menu-list">${modules.map(module => {
      const steps = stepsFor(module); const viewed = steps.filter(step => progress.viewed.includes(step.id)).length;
      return `<button type="button" data-action="guides.module" data-module="${module.id}"><span>${esc(module.title)}</span><small>${esc(module.body)}</small><small>${viewed}/${steps.length} steps viewed · ${progress.practiced[module.id] === signature(module) ? 'Practice confirmed by you' : 'Practice not confirmed'}</small><b aria-hidden="true">→</b></button>`;
    }).join('')}</div><p class="guide-save-note">${notice()}</p></section></div>`;
  requestAnimationFrame(focusSurface);
}

function focusSurface() { document.querySelector('.guide-card, .guide-menu')?.focus(); }
function positionStep(target) {
  const spot = document.querySelector('.guide-spotlight'); const card = document.querySelector('.guide-card');
  if (!spot || !card || !active || !sameScope()) return;
  const rect = target.getBoundingClientRect();
  Object.assign(spot.style, { left: `${rect.left - 6}px`, top: `${rect.top - 6}px`, width: `${rect.width + 12}px`, height: `${rect.height + 12}px` });
  const cardRect = card.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.left, (window.innerWidth || 1280) - cardRect.width - 12));
  const below = rect.bottom + 14;
  const top = below + cardRect.height <= (window.innerHeight || 720) - 12 ? below : Math.max(12, rect.top - cardRect.height - 14);
  Object.assign(card.style, { left: `${left}px`, top: `${top}px`, opacity: '1' }); card.focus();
}

registerActions({
  'guides.open': () => openGuideMenu(),
  'guides.module': ds => startModule(ds.module),
  'guides.quickStart': () => startModule(modulesFor()[0]?.id, true),
  'guides.resume': () => { if (!sameScope()) return; const resume = readProgress().resume; if (resume) startModule(resume.moduleId, resume.full, resume); },
  'guides.close': () => closeGuides(),
  'guides.closeMenu': () => closeGuides(),
  'guides.back': () => move(-1),
  'guides.next': () => move(1),
  'guides.confirm': () => confirmPractice(),
  'guides.continue': () => continueOnboarding(),
});
registerChangeActions({ 'guides.check': (ds, element) => {
  if (!sameScope() || !active?.practice || !currentStepAllowed()) return;
  const module = currentModule(); if (!practiceFor(module).some(item => item.id === ds.item)) return;
  const progress = readProgress(); const id = `${module.id}:${ds.item}`;
  progress.checked = progress.checked.filter(value => value !== id);
  if (element.checked) progress.checked.push(id);
  delete progress.practiced[module.id]; saveProgress(progress);
  // Keep the checkbox focused while updating the confirmation state.
  const confirm = container()?.querySelector('[data-action="guides.confirm"]');
  if (confirm) confirm.disabled = !stepsFor(module).every(step => progress.viewed.includes(step.id)) || !practiceFor(module).every(item => progress.checked.includes(`${module.id}:${item.id}`));
  const note = container()?.querySelector('.guide-save-note'); if (note) note.textContent = notice();
  const complete = container()?.querySelector('.guide-complete'); if (complete) complete.remove();
} });

document.addEventListener?.('keydown', e => {
  if (!container()?.firstElementChild || !sameScope()) return;
  if (active && !currentStepAllowed()) { openGuideMenu(false); return; }
  e.stopImmediatePropagation?.();
  if (e.key === 'Tab') {
    const surface = document.querySelector('.guide-card, .guide-menu');
    const controls = [...(surface?.querySelectorAll('button:not([disabled]), input:not([disabled]), summary, [tabindex="0"]') || [])].filter(el => el.getClientRects().length);
    if (!controls.length) return;
    if (!surface.contains(document.activeElement) || document.activeElement === (e.shiftKey ? controls[0] : controls.at(-1)) || document.activeElement === surface) {
      e.preventDefault(); (e.shiftKey ? controls.at(-1) : controls[0]).focus();
    }
  } else if (e.key === 'Escape') { e.preventDefault(); closeGuides(); }
}, true);
window.addEventListener?.('resize', () => {
  if (!active || active.practice || !sameScope() || !currentStepAllowed()) return;
  const step = currentStep(); const target = document.querySelector(`[data-guide="${step.target || step.id}"]`);
  if (target) positionStep(target);
});
