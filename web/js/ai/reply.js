// ─── AI reply / composer actions ─────────────────────────────────────────────
// Powers the composer's "AI ▾" menu: Draft, Improve, Shorten, Lengthen,
// Friendly, Formal, Translate, and the KB-grounded reply. Each action sends
// the current draft (and ticket context) to Claude with an action-specific
// system prompt, then drops the response back into the composer textarea.
//
// AI_THINKING (read by aiAction here and by aiSend/sendCompose in app.js to
// gate concurrent AI calls and disable the AI-page input) lives in
// core/state.js so all three callers share one flag.
//
// Drafts use published workspace knowledge through the server's kb_draft action.
// onComposeInput is a direct import from tickets/detail.

import { TICKETS } from '../core/data.js';
import { AI_THINKING, setAiThinking } from '../core/state.js';
import { callClaude } from './client.js';
import { onComposeInput } from '../tickets/detail.js';
import { focusEnd, getPlainText, setText } from '../tickets/composer.js';

export async function aiAction(id, action) {
  // Close the AI-action menu (one-line helper; inlined to avoid a bridge entry).
  const menu = document.getElementById('ai-menu-' + id);
  if (menu) menu.style.display = 'none';
  if (AI_THINKING) return;
  const t = TICKETS.find(x => x.id === id);
  const el = document.getElementById('compose-' + id);
  if (!t || !el) return;
  // AI works on (and returns) plain text; in the rich editor that replaces the
  // content, which is what "draft/improve/shorten" means to an agent.
  const current = getPlainText(id);
  if (!['draft', 'kb-reply'].includes(action) && !current.trim()) {
    setText(id, `Type something first — AI ${action} works on the current draft.`);
    onComposeInput(id);
    return;
  }
  setAiThinking(true);
  const th = document.getElementById('thinking-' + id);
  if (th) th.classList.add('show');

  let systemMsg, userMsg;
  if (action === 'draft' || action === 'kb-reply') {
    const hist = (t.msgs || []).map(m => `${m.from}: ${m.t}`).join('\n\n');
    systemMsg = 'You are a professional B2B SaaS support agent. Draft a concise, helpful reply. Output ONLY the reply text — no labels, no preamble.';
    userMsg = `Ticket: ${t.subject}\n\n${hist}\n\nDraft a reply:`;
  } else {
    const instructions = {
      improve:   'Rewrite the following text to improve clarity and professionalism. Keep the same meaning and roughly the same length. Output ONLY the rewritten text.',
      shorten:   'Shorten the following text by 30-50% while preserving all key information. Output ONLY the rewritten text.',
      lengthen:  'Expand the following text with more detail and helpful context, while staying professional and on-topic. Output ONLY the rewritten text.',
      friendly:  'Rewrite the following text to be warmer and friendlier in tone, while staying professional. Output ONLY the rewritten text.',
      formal:    'Rewrite the following text in a more formal, business tone. Output ONLY the rewritten text.',
      translate: 'Translate the following text into clear, natural English. If it is already English, polish it lightly. Output ONLY the result.',
    };
    systemMsg = instructions[action] || instructions.improve;
    userMsg = current;
  }

  try {
    const { text, error } = await callClaude({
      action: ['draft', 'kb-reply'].includes(action) ? 'kb_draft' : 'draft',
      system: systemMsg,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 800,
    });
    const txt = text || error;
    if (txt) setText(id, txt);
  } catch (err) {
    alert(err?.message || 'AI unavailable. Please try again.');
  }
  setAiThinking(false);
  if (th) th.classList.remove('show');
  onComposeInput(id);
  focusEnd(id);
}

