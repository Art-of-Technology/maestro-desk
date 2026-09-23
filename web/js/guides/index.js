import { CURRENT_PAGE, SESSION } from '../core/state.js';
import { getWorkspaceId } from '../core/api-client.js';
import { registerActions } from '../core/event-delegation.js';
import { GUIDE_STEPS, GUIDE_VERSION } from './config.js';

let activeStep = null;
let navigate = null;

function container() { return document.getElementById('guide-container'); }
function storageKey() { return `respovia_guides:${getWorkspaceId() || 'demo'}:${SESSION?.userId || SESSION?.name || 'user'}`; }
function isComplete() { return localStorage.getItem(storageKey()) === GUIDE_VERSION; }
function markComplete() { localStorage.setItem(storageKey(), String(GUIDE_VERSION)); }

export function initGuides(nav) { navigate = nav; }

export function maybeStartGuides() {
  if (CURRENT_PAGE === 'dashboard' && !isComplete()) startGuide(0);
}

export function guidePageRendered(page) {
  if (activeStep !== null && GUIDE_STEPS[activeStep]?.page === page) renderStep();
}

export function closeGuides(remember = true) {
  if (remember && activeStep !== null) markComplete();
  activeStep = null;
  if (container()) container().innerHTML = '';
}

function startGuide(index) {
  const next = Number(index);
  if (!Number.isInteger(next) || !GUIDE_STEPS[next]) return;
  activeStep = next;
  const page = GUIDE_STEPS[next].page;
  if (CURRENT_PAGE === page) renderStep(); else navigate?.(page);
}

function move(offset) {
  const next = activeStep + offset;
  if (next < 0) return;
  if (next >= GUIDE_STEPS.length) return closeGuides();
  startGuide(next);
}

function renderStep() {
  const step = GUIDE_STEPS[activeStep];
  const target = document.querySelector?.(`[data-guide="${step.target || step.id}"]`);
  const host = container();
  if (!target || !host) return;
  target.scrollIntoView?.({ block: 'nearest' });
  host.innerHTML = `
    <div class="guide-layer">
      <div class="guide-spotlight" aria-hidden="true"></div>
      <section class="guide-card" role="dialog" aria-modal="true" aria-labelledby="guide-title" aria-describedby="guide-copy" tabindex="-1">
        <div class="guide-meta"><span>GETTING STARTED · ${activeStep + 1} OF ${GUIDE_STEPS.length}</span><button type="button" data-action="guides.close">Exit</button></div>
        <h2 id="guide-title">${window.escHtml(step.title)}</h2>
        <p id="guide-copy">${window.escHtml(step.body)}</p>
        <ol class="guide-instructions" tabindex="0" aria-label="Instructions">${step.instructions.map(text => `<li>${window.escHtml(text)}</li>`).join('')}</ol>
        <div class="guide-foot">
          <button type="button" class="btn" data-action="guides.back" ${activeStep === 0 ? 'disabled' : ''}>← Back</button>
          <span class="guide-progress">${activeStep + 1} / ${GUIDE_STEPS.length}</span>
          <button type="button" class="btn btn-solid" data-action="guides.next">${activeStep === GUIDE_STEPS.length - 1 ? 'Finish' : 'Next →'}</button>
        </div>
      </section>
    </div>`;
  requestAnimationFrame(() => positionStep(target));
}

function positionStep(target) {
  const spot = document.querySelector?.('.guide-spotlight');
  const card = document.querySelector?.('.guide-card');
  if (!spot || !card || activeStep === null) return;
  const rect = target.getBoundingClientRect();
  const pad = 6;
  Object.assign(spot.style, {
    left: `${rect.left - pad}px`, top: `${rect.top - pad}px`,
    width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px`,
  });
  const gap = 14;
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 720;
  const cardRect = card.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.left, vw - cardRect.width - 12));
  const below = rect.bottom + gap;
  const top = below + cardRect.height <= vh - 12 ? below : Math.max(12, rect.top - cardRect.height - gap);
  Object.assign(card.style, { left: `${left}px`, top: `${top}px`, opacity: '1' });
  card.focus();
}

function openGuideMenu() {
  activeStep = null;
  const host = container();
  if (!host) return;
  host.innerHTML = `
    <div class="guide-layer guide-menu-layer" data-action="guides.closeMenu">
      <section class="guide-menu" role="dialog" aria-modal="true" aria-labelledby="guide-menu-title" data-action="" tabindex="-1">
        <div class="guide-menu-head"><div><div class="guide-kicker">GUIDED TOURS</div><h2 id="guide-menu-title">Learn Respovia</h2></div><button type="button" class="modal-close" data-action="guides.closeMenu" aria-label="Close">×</button></div>
        <p>Learn how to handle your first ticket, or choose a topic for a reminder. Exit the tour when you are ready to practise.</p>
        <button type="button" class="btn btn-solid guide-start" data-action="guides.start" data-step="0">Start the full tour</button>
        <div class="guide-menu-list">${GUIDE_STEPS.map((step, i) => `
          <button type="button" data-action="guides.start" data-step="${i}"><span>${window.escHtml(step.title)}</span><small>${window.escHtml(step.body)}</small><b>→</b></button>`).join('')}</div>
        ${isComplete() ? '<div class="guide-complete">✓ Tour viewed</div>' : ''}
      </section>
    </div>`;
  requestAnimationFrame(() => document.querySelector?.('.guide-menu')?.focus());
}

registerActions({
  'guides.open': () => openGuideMenu(),
  'guides.start': ds => startGuide(ds.step),
  'guides.close': () => closeGuides(),
  'guides.closeMenu': () => closeGuides(false),
  'guides.back': () => move(-1),
  'guides.next': () => move(1),
});

document.addEventListener?.('keydown', e => {
  if (!container()?.firstElementChild) return;
  if (e.key === 'Tab') {
    const surface = document.querySelector?.('.guide-card, .guide-menu');
    const buttons = [...(surface?.querySelectorAll('button:not([disabled]), [tabindex="0"]') || [])];
    if (!buttons.length) return;
    const edge = e.shiftKey ? buttons[0] : buttons.at(-1);
    if (document.activeElement === edge || (e.shiftKey && document.activeElement === surface)) {
      e.preventDefault();
      (e.shiftKey ? buttons.at(-1) : buttons[0]).focus();
    }
  } else if (e.key === 'Escape') closeGuides(activeStep !== null);
  else if (activeStep !== null && e.key === 'ArrowLeft') move(-1);
  else if (activeStep !== null && e.key === 'ArrowRight') move(1);
});

window.addEventListener?.('resize', () => {
  if (activeStep === null) return;
  const step = GUIDE_STEPS[activeStep];
  const target = document.querySelector?.(`[data-guide="${step.target || step.id}"]`);
  if (target) positionStep(target);
});
