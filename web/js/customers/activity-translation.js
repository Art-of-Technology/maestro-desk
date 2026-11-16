import { TICKETS } from '../core/data.js';
import { AGENT_PREFERRED_LANG, translateText } from '../ai/translate.js';
import { messageTranslationRequest, translationScope } from '../ai/translation-cache.js';
import { registerActions } from '../core/event-delegation.js';

const translations = new WeakMap();

export async function translateActivity(ds, button, entry) {
  const row = button.closest('.cust-timeline-item');
  const text = row?.querySelector('[data-activity-text]'), status = row?.querySelector('[data-activity-status]');
  const ticket = entry?.ticket || TICKETS.find(t => t.id === ds.ticketId);
  const message = entry?.message || ticket?.msgs?.[Number(ds.messageIndex)];
  if (!text || !status || !message?.t || button.disabled) return;
  const scope = translationScope(), target = AGENT_PREFERRED_LANG, source = message.t;
  const previous = translations.get(row);
  if (previous?.showing) {
    text.textContent = source;
    previous.showing = false;
    button.textContent = 'Translate';
    status.textContent = '';
    return;
  }
  button.disabled = true;
  status.textContent = 'Translating…';
  try {
    let warning = false;
    const request = messageTranslationRequest(message._uuid || [ticket._uuid || ticket.id, Number(ds.messageIndex)], scope);
    const result = await translateText(source, target, async body => {
      const response = await request(body);
      warning ||= !!response.cacheWarning;
      return response;
    });
    if (!row.isConnected || scope !== translationScope() || message.t !== source) return;
    if (result.error) throw new Error(result.error);
    text.textContent = result.translation;
    translations.set(row, { showing: true });
    button.textContent = 'Show original';
    status.textContent = 'Translated to ' + target + (warning ? '. Could not save translation; translating again may use AI credits.' : '');
  } catch (error) {
    if (row.isConnected && scope === translationScope()) status.textContent = error.message || 'Could not translate. Try again.';
  } finally {
    if (row.isConnected) {
      button.disabled = false;
      if (status.textContent === 'Translating…') status.textContent = '';
    }
  }
}

registerActions({ 'cust.translateActivity': translateActivity });
