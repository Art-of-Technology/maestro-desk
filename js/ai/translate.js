// ─── Translator ──────────────────────────────────────────────────────────────
// Owns:
//   • per-message and thread-wide translation of customer messages into the
//     agent's preferred language (live with AGENT_PREFERRED_LANG)
//   • language detection (cached on t.detectedCustomerLang)
//   • the standalone Translator modal (showTranslatorModal + runTranslator)
//   • the auto-translate-replies toggle that wraps outgoing replies in the
//     customer's language at send time (consumed by sendCompose in app.js)
//
// Imports callClaude + AI_API_KEY from ./client.js, TICKETS from
// core/data.js, and CURRENT_TICKET from core/state.js.
//
// openTicket is now a direct ES import from tickets/detail.js (the cycle
// with detail.js is tolerated — each binding is only used inside a
// function body, never at module top level). showModal and escHtml are
// still reached through window — they live in app.js / core/modal.js
// and the lifts haven't happened yet.

import { TICKETS } from '../core/data.js';
import { CURRENT_TICKET } from '../core/state.js';
import { AI_API_KEY, callClaude } from './client.js';
import { openTicket } from '../tickets/detail.js';
import { showModal } from '../core/modal.js';
import { registerActions } from '../core/event-delegation.js';

export let AGENT_PREFERRED_LANG = localStorage.getItem('agent_preferred_lang') || 'English';

export const TRANSLATOR_LANGS = [
  'English','Spanish','French','German','Italian','Portuguese','Dutch','Swedish','Norwegian','Danish','Finnish','Polish','Czech','Hungarian','Romanian','Greek','Russian','Ukrainian','Turkish','Arabic','Hebrew','Hindi','Japanese','Mandarin Chinese','Cantonese','Korean','Thai','Vietnamese','Indonesian',
];

export async function translateText(text, targetLang) {
  if (!AI_API_KEY) return { error: 'No Claude API key configured. Add one in Settings → AI Assistant.' };
  if (!text || !text.trim()) return { error: 'No text to translate.' };
  try {
    const { text: translation, error } = await callClaude({
      system: `You are a translator. Translate the following text into ${targetLang || 'English'}. Output ONLY the translated text — no labels, no preamble, no quotes. If the text is already in the target language, polish it lightly for clarity.`,
      messages: [{ role: 'user', content: text }],
      maxTokens: 1000,
    });
    return translation ? { translation } : { error: error || 'Could not translate.' };
  } catch (e) {
    return { error: 'Translation failed: ' + (e?.message || 'network error') };
  }
}

export async function translateMessage(ticketId, msgIdx) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t || !t.msgs[msgIdx]) return;
  const m = t.msgs[msgIdx];
  m.translating = true;
  openTicket(ticketId);
  const res = await translateText(m.t, 'English');
  m.translating = false;
  m.translation = res.translation || ('⚠ ' + (res.error || 'Translation failed'));
  openTicket(ticketId);
}

export function hideMessageTranslation(ticketId, msgIdx) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t || !t.msgs[msgIdx]) return;
  delete t.msgs[msgIdx].translation;
  openTicket(ticketId);
}

export async function detectLanguage(text) {
  if (!AI_API_KEY) return null;
  const sample = String(text || '').slice(0, 600);
  if (!sample.trim()) return null;
  try {
    const { text: out } = await callClaude({
      system: 'Identify the language of the text. Reply with ONLY the English name of the language using its common form (e.g. "French", "Japanese", "Spanish", "Mandarin Chinese", "English"). Nothing else — no punctuation, no explanation.',
      messages: [{ role: 'user', content: sample }],
      maxTokens: 30,
    });
    return (out || '').trim() || null;
  } catch {
    return null;
  }
}

export async function detectAndTranslateThread(ticketId) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t || !t.translateThread) return;
  if (!t.detectedCustomerLang) {
    const firstCust = (t.msgs || []).find(m => m.r === 'customer');
    if (firstCust) {
      const lang = await detectLanguage(firstCust.t);
      if (lang) t.detectedCustomerLang = lang;
    }
  }
  // Translate all stale customer messages in parallel — long threads no longer block on serial round-trips.
  const target = AGENT_PREFERRED_LANG;
  const stale = (t.msgs || []).filter(m =>
    m.r === 'customer' && (m.translatedFor !== target || !m.translation)
  );
  if (stale.length) {
    await Promise.all(stale.map(async m => {
      const res = await translateText(m.t, target);
      if (res.translation) {
        m.translation = res.translation;
        m.translatedFor = target;
      }
    }));
  }
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
  return stale.length > 0;
}

export function toggleThreadTranslate(ticketId, on) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t) return;
  t.translateThread = !!on;
  if (on) detectAndTranslateThread(ticketId);
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
}

export function toggleAutoTranslateReplies(ticketId, on) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t) return;
  t.autoTranslateReplies = !!on;
  // If turning on without a known customer language, kick off detection.
  if (on && !t.detectedCustomerLang) {
    const firstCust = (t.msgs || []).find(m => m.r === 'customer');
    if (firstCust) detectLanguage(firstCust.t).then(lang => {
      if (lang) { t.detectedCustomerLang = lang; if (CURRENT_TICKET === ticketId) openTicket(ticketId); }
    });
  }
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
}

export function setCustomerLanguage(ticketId, lang) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t || !lang) return;
  t.detectedCustomerLang = lang;
  // No need to re-translate customer messages (target = AGENT_PREFERRED_LANG, unchanged) —
  // but if the agent had auto-translate-replies on, the new language becomes the target for
  // outgoing replies, so just re-render so the toolbar reflects the override.
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
}

export function setAgentPreferredLang(v) {
  AGENT_PREFERRED_LANG = v;
  localStorage.setItem('agent_preferred_lang', v);
  // If a ticket is open with thread translation on, refresh stale translations against the new target.
  if (CURRENT_TICKET) {
    const t = TICKETS.find(x => x.id === CURRENT_TICKET);
    if (t && t.translateThread) detectAndTranslateThread(CURRENT_TICKET);
  }
}

export function showTranslatorModal(prefillText) {
  const langs = TRANSLATOR_LANGS.map(l => `<option value="${l}">${l}</option>`).join('');
  showModal('Translator', `
    <div class="form-row">
      <label class="form-label">Source text</label>
      <textarea class="form-input" id="tx-src" placeholder="Paste text to translate…" style="min-height:120px;font-family:'Inter',sans-serif">${prefillText ? window.escHtml(prefillText) : ''}</textarea>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label class="form-label">Target language</label>
        <select class="form-input" id="tx-target">${langs}</select>
      </div>
      <div class="form-row" style="display:flex;align-items:flex-end">
        <button class="btn btn-solid" data-action="tx.run" style="width:100%;justify-content:center">Translate</button>
      </div>
    </div>
    <div id="tx-result-wrap" style="display:none">
      <div class="form-label" style="margin-top:6px">Result</div>
      <div id="tx-result" style="padding:12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);font-size:13px;color:var(--ink);line-height:1.6;white-space:pre-wrap;min-height:80px;transition:background .3s"></div>
      <div style="margin-top:8px;display:flex;gap:6px;align-items:center">
        <button class="btn btn-sm" data-action="tx.copy">Copy</button>
        <span id="tx-status" style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)"></span>
      </div>
    </div>
    <div style="margin-top:10px;font-size:11px;color:var(--ink3);line-height:1.5">Uses your configured Claude API key. ${AI_API_KEY ? '' : 'Add one in Settings → AI Assistant to enable.'}</div>
  `, null, null);
}

async function runTranslator() {
  const src    = document.getElementById('tx-src')?.value || '';
  const target = document.getElementById('tx-target')?.value || 'English';
  const wrap   = document.getElementById('tx-result-wrap');
  const result = document.getElementById('tx-result');
  const status = document.getElementById('tx-status');
  if (!result || !wrap) return;
  if (!src.trim()) {
    result.textContent = 'Please paste some text first.';
    result.style.color = 'var(--red)';
    wrap.style.display = 'block';
    return;
  }
  result.textContent = 'Translating…';
  result.style.color = 'var(--purple)';
  result.style.fontStyle = 'italic';
  if (status) status.textContent = '';
  wrap.style.display = 'block';
  const res = await translateText(src, target);
  result.style.fontStyle = 'normal';
  if (res.translation) {
    result.style.color = 'var(--ink)';
    result.textContent = res.translation;
  } else {
    result.style.color = 'var(--red)';
    result.textContent = res.error || 'Could not translate.';
  }
}

function copyTxResult() {
  const result = document.getElementById('tx-result');
  const status = document.getElementById('tx-status');
  if (!result) return;
  const text = result.textContent;
  const flash = msg => {
    if (!status) return;
    status.textContent = msg;
    setTimeout(() => { if (status) status.textContent = ''; }, 1800);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => flash('Copied to clipboard'),
      () => flash('Copy failed — select the text and use Ctrl+C')
    );
    return;
  }
  // Fallback for non-secure contexts (file://, http://) where Clipboard API is unavailable
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    flash(ok ? 'Copied to clipboard' : 'Copy failed — select the text and use Ctrl+C');
  } catch {
    flash('Copy not supported — select the text and use Ctrl+C');
  }
}

// The standalone Translator modal's two buttons. The modal HTML is injected by
// showModal, so document-level click delegation catches these.
registerActions({
  'tx.run':  () => runTranslator(),
  'tx.copy': () => copyTxResult(),
});
