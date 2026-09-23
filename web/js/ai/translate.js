// ─── Translator ──────────────────────────────────────────────────────────────
// Owns:
//   • per-message and thread-wide translation of customer messages into the
//     agent's preferred language (live with AGENT_PREFERRED_LANG)
//   • language detection (cached on t.detectedCustomerLang)
//   • the standalone Translator modal (showTranslatorModal + runTranslator)
//   • the auto-translate-replies toggle that wraps outgoing replies in the
//     customer's language at send time (consumed by sendCompose in app.js)
//
// Imports callClaude from ./client.js, TICKETS from
// core/data.js, and CURRENT_TICKET from core/state.js.
//
// openTicket is now a direct ES import from tickets/detail.js (the cycle
// with detail.js is tolerated — each binding is only used inside a
// function body, never at module top level). showModal and escHtml are
// still reached through window — they live in app.js / core/modal.js
// and the lifts haven't happened yet.

import { TICKETS } from '../core/data.js';
import { CURRENT_TICKET } from '../core/state.js';
import { callClaude } from './client.js';
import { LANGUAGE_DETECTION_PROMPT } from './language-detection-prompt.js';
import { translateFormatted } from './formatted-translation.js';
import { messageTranslationRequest, translationScope } from './translation-cache.js';
import { openTicket } from '../tickets/detail.js';
import { showModal } from '../core/modal.js';
import { registerActions } from '../core/event-delegation.js';

export let AGENT_PREFERRED_LANG = localStorage.getItem('agent_preferred_lang') || 'English';

export const TRANSLATOR_LANGS = [
  'English','Spanish','French','German','Italian','Portuguese','Dutch','Swedish','Norwegian','Danish','Finnish','Polish','Czech','Hungarian','Romanian','Greek','Russian','Ukrainian','Turkish','Arabic','Hebrew','Hindi','Japanese','Mandarin Chinese','Cantonese','Korean','Thai','Vietnamese','Indonesian',
];

export async function translateText(text, targetLang, request = callClaude) {
  if (!text || !text.trim()) return { error: 'No text to translate.' };
  try {
    const { text: translation, error } = await request({
      system: `You are a translator. Translate the following text into ${targetLang || 'English'}. Preserve paragraphs, line breaks, lists and existing formatting. Output ONLY the translated text — no labels, no preamble, no quotes. If the text is already in the target language, return it unchanged.`,
      messages: [{ role: 'user', content: text }],
      maxTokens: 1000,
      action: 'translate',
    });
    return translation ? { translation } : { error: error || 'Could not translate.' };
  } catch (e) {
    return { error: 'Translation failed: ' + (e?.message || 'network error') };
  }
}

export function messageTranslationSource(message) {
  return JSON.stringify([message.t, message.html || null]);
}

export function hasMessageTranslation(message, target = AGENT_PREFERRED_LANG) {
  return message.translationScope === translationScope() && message.translatedFor === target
    && message.translationSource === messageTranslationSource(message) && !!message.translation;
}

async function translateMessageContent(ticket, message, index, target) {
  const source = messageTranslationSource(message);
  const scope = translationScope();
  const messageKey = message._uuid || [ticket._uuid || ticket.id, index];
  const request = messageTranslationRequest(messageKey, scope, message.html ? 'array' : 'text');
  const detectRequest = messageTranslationRequest(messageKey, scope);
  const language = message.translatedTo || await detectLanguage(message.t, async body => {
    const response = await detectRequest(body);
    if (response.cacheWarning) message.translationCacheWarning = true;
    return response;
  }, true, ticket._uuid);
  const cachedRequest = async body => {
    const response = await request(body);
    if (response.cacheWarning) message.translationCacheWarning = true;
    return response;
  };
  // Detection samples 600 characters; longer/mixed messages still translate.
  const result = language?.toLowerCase() === target.toLowerCase() && (message.translatedTo || String(message.t).length <= 600)
    ? { translation: message.t, translationHtml: message.html || null }
    : message.html
    ? await translateFormatted(message.html, target, cachedRequest)
    : await translateText(message.t, target, cachedRequest);
  if (result.error) throw new Error(result.error);
  if (source !== messageTranslationSource(message) || scope !== translationScope()) return;
  message.translation = result.translation;
  message.translationHtml = result.translationHtml || null;
  message.translatedFor = target;
  message.translationSource = source;
  message.translationScope = scope;
}

// Kept for existing action callers; both controls now select a conversation view.
export function translateMessage(ticketId) { return toggleThreadTranslate(ticketId, true); }
export function hideMessageTranslation(ticketId) { return toggleThreadTranslate(ticketId, false); }

export async function detectLanguage(text, request = callClaude, throwErrors = false, ticketId) {
  const sample = String(text || '').slice(0, 600);
  if (!sample.trim()) return null;
  try {
    const { text: out } = await request({
      system: LANGUAGE_DETECTION_PROMPT,
      messages: [{ role: 'user', content: sample }],
      maxTokens: 30,
      action: 'detect_language',
      ...(ticketId ? { ticketId } : {}),
    });
    return TRANSLATOR_LANGS.find(l => l.toLowerCase() === (out || '').trim().toLowerCase()) || null;
  } catch (error) {
    if (throwErrors) throw error;
    return null;
  }
}

const runningThreads = new WeakMap();

export async function detectAndTranslateThread(ticketId) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t || !t.translateThread) return;
  if (runningThreads.has(t)) return runningThreads.get(t);
  const target = AGENT_PREFERRED_LANG;
  const scope = translationScope();
  const work = async () => {
    t.translationError = null;
    t.translatingThread = true;
    try {
      if (CURRENT_TICKET === ticketId && scope === translationScope()) openTicket(ticketId);
      // Serial messages let Original stop queued paid work, and avoid bursts.
      for (const [index, message] of (t.msgs || []).entries()) {
        if (!t.translateThread || target !== AGENT_PREFERRED_LANG || scope !== translationScope()) break;
        if (!['customer', 'agent', 'note', 'ai'].includes(message.r) || !String(message.t || '').trim() || hasMessageTranslation(message, target)) continue;
        await translateMessageContent(t, message, index, target);
      }
    } catch (error) {
      if (scope === translationScope() && target === AGENT_PREFERRED_LANG && t.translateThread) {
        t.translationError = error?.message || 'Could not translate this conversation. Please try again.';
      }
    } finally {
      t.translatingThread = false;
      runningThreads.delete(t);
      if (CURRENT_TICKET === ticketId && scope === translationScope()) openTicket(ticketId);
    }
  };
  // Start on a microtask so the guard exists before any synchronous failure.
  const task = Promise.resolve().then(work);
  runningThreads.set(t, task);
  return task;
}

export function toggleThreadTranslate(ticketId, on) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t) return;
  t.translateThread = !!on;
  t.translationError = null;
  const task = on ? detectAndTranslateThread(ticketId) : undefined;
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
  return task;
}

// Called after rendering: new messages use saved results or translate once.
export function ensureConversationTranslation(ticket) {
  if (!ticket.translateThread || ticket.translationError || runningThreads.has(ticket)) return;
  if ((ticket.msgs || []).some(m => ['customer', 'agent', 'note', 'ai'].includes(m.r) && String(m.t || '').trim() && !hasMessageTranslation(m))) {
    void detectAndTranslateThread(ticket.id);
  }
}

function languagePreferenceKey(t) {
  const scope = translationScope();
  return scope ? `respovia-reply-language:${scope}:${t._uuid || t.id}` : null;
}

export function initialiseReplyLanguage(t) {
  t.autoTranslateReplies ??= true;
  const key = languagePreferenceKey(t);
  if (!key || t.replyLanguagePreferenceKey === key) return;
  if (t.replyLanguagePreferenceKey) {
    t.autoTranslateReplies = true;
    t.customerLanguageManual = false;
    t.detectedCustomerLang = null;
    t.customerLanguageSource = null;
    t.customerLanguageError = false;
    t.detectingCustomerLanguage = false;
  }
  t.replyLanguagePreferenceKey = key;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (typeof saved?.enabled === 'boolean') t.autoTranslateReplies = saved.enabled;
    if (TRANSLATOR_LANGS.includes(saved?.language)) {
      t.customerLanguageManual = true;
      t.detectedCustomerLang = saved.language;
    }
  } catch { /* Preferences still work for this ticket if storage is unavailable. */ }
}

function saveReplyLanguage(t) {
  const key = languagePreferenceKey(t);
  if (key) try { sessionStorage.setItem(key, JSON.stringify({ enabled: t.autoTranslateReplies,
    language: t.customerLanguageManual ? t.detectedCustomerLang : null })); } catch {}
}

export function customerLanguageStatus(t) {
  if (t.customerLanguageManual) return `Customer language: ${t.detectedCustomerLang} · Selected manually`;
  if (t.detectingCustomerLanguage) return 'Customer language: Detecting…';
  if (t.detectedCustomerLang) return `Customer language: ${t.detectedCustomerLang} · Detected automatically`;
  if (t.customerLanguageError) return 'Customer language: Detection failed · Retry or choose a language';
  return 'Customer language: Unknown · Choose a language';
}

export function outgoingLanguageStatus(t) {
  return t.autoTranslateReplies !== false
    ? (t.detectedCustomerLang ? `Reply language: ${t.detectedCustomerLang}` : 'Choose reply language before sending')
    : 'Reply language: As written';
}

function refreshLanguageStatus(t) {
  const customer = document.getElementById(`customer-language-${t.id}`);
  const reply = document.getElementById(`reply-language-${t.id}`);
  if (customer) customer.textContent = customerLanguageStatus(t);
  if (reply) reply.textContent = outgoingLanguageStatus(t);
  const retry = document.getElementById(`retry-language-${t.id}`);
  if (retry) retry.hidden = !!(t.detectedCustomerLang || t.detectingCustomerLanguage);
}

const languageChecks = new WeakMap();
export function latestCustomerText(t) {
  const message = (t.msgs || []).findLast(m => m.r === 'customer' && String(m.t || '').trim());
  return { message, text: String(message?.t || '').split(/\n\s*(?:On .+wrote:|El .+escribió:|From:|De:|-----Original Message-----)/i)[0].trim() };
}

export async function ensureCustomerLanguage(t, { refresh = false } = {}) {
  initialiseReplyLanguage(t);
  if (t.customerLanguageManual) return t.detectedCustomerLang;
  const { message, text } = latestCustomerText(t);
  const scope = translationScope();
  if (!scope || !t._uuid || !t._detailLoaded) return t.detectedCustomerLang || null;
  const source = JSON.stringify([scope, message?._uuid, text]);
  if (!refresh && t.customerLanguageSource === source) return t.detectedCustomerLang || null;
  const pending = languageChecks.get(t);
  if (pending?.source === source && (!refresh || pending.refresh)) return pending.task;
  t.customerLanguageSource = null;
  t.detectedCustomerLang = null;
  t.customerLanguageError = false;
  t.detectingCustomerLanguage = !!text;
  refreshLanguageStatus(t);
  const check = { source, refresh };
  const task = Promise.resolve().then(async () => {
    let language = null;
    let failed = false;
    try {
      if (text) language = await detectLanguage(text, messageTranslationRequest(message._uuid || [t._uuid, text.slice(0, 30)], scope, 'text', { refresh }), true, t._uuid);
    } catch { failed = true; }
    const latest = latestCustomerText(t);
    if (scope !== translationScope() || t.customerLanguageManual || JSON.stringify([scope, latest.message?._uuid, latest.text]) !== source || languageChecks.get(t) !== check) return null;
    t.detectingCustomerLanguage = false;
    t.customerLanguageSource = source;
    t.detectedCustomerLang = language;
    t.customerLanguageError = failed;
    refreshLanguageStatus(t);
    return language;
  }).finally(() => { if (languageChecks.get(t) === check) languageChecks.delete(t); });
  check.task = task;
  languageChecks.set(t, check);
  return task;
}

export function retryCustomerLanguage(ticketId) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t) return;
  return ensureCustomerLanguage(t, { refresh: true });
}

export async function prepareCustomerReply(t, text, html, request = callClaude) {
  initialiseReplyLanguage(t);
  if (!text.trim()) return { translation: text, translationHtml: html, translatedTo: null, replyLanguage: null };
  if (!t.autoTranslateReplies) {
    // Detection returns null on provider failure unless throwErrors is explicitly enabled.
    const replyLanguage = t.detectedCustomerLang ? await detectLanguage(text, request, false, t._uuid) : null;
    return { translation: text, translationHtml: html, translatedTo: null, replyLanguage };
  }
  const language = await ensureCustomerLanguage(t);
  if (!language) throw new Error('Choose the customer language before sending. Your draft has been kept.');
  const writtenLanguage = await detectLanguage(text, request, true, t._uuid);
  if (writtenLanguage === language) return { translation: text, translationHtml: html, translatedTo: null, replyLanguage: writtenLanguage };
  const result = html ? await translateFormatted(html, language, request) : await translateText(text, language, request);
  if (result.error || !result.translation?.trim()) throw new Error('Could not translate the reply. Your draft has been kept. Try again before sending.');
  return { ...result, translatedTo: language, replyLanguage: language };
}

export function toggleAutoTranslateReplies(ticketId, on) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t) return;
  t.autoTranslateReplies = !!on;
  saveReplyLanguage(t);
  if (on) void ensureCustomerLanguage(t);
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
}

export function setCustomerLanguage(ticketId, lang) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t || (lang && !TRANSLATOR_LANGS.includes(lang))) return;
  t.customerLanguageManual = !!lang;
  languageChecks.delete(t);
  t.customerLanguageError = false;
  t.detectedCustomerLang = lang || null;
  t.detectingCustomerLanguage = false;
  if (!lang) t.customerLanguageSource = null;
  saveReplyLanguage(t);
  if (!lang) void ensureCustomerLanguage(t);
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
    <div style="margin-top:10px;font-size:11px;color:var(--ink3);line-height:1.5">Uses your workspace AI connection and credit.</div>
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
