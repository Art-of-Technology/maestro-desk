// ─── AI Intelligence page ────────────────────────────────────────────────────
// The /ai chat page — workspace-aware Claude conversation with persisted
// history per browser. Owns:
//
//   • Conversation list (AI_CONVERSATIONS) persisted to localStorage,
//     hydrated on module load so refresh restores the chat that was open.
//   • Context-source toggles (AI_CONTEXT_SOURCES) — which slices of
//     workspace data the model sees: tickets / customers / agents / KB.
//   • The prompt cards (AI_PROMPT_CARDS) and follow-up suggestions
//     (AI_FOLLOWUPS) shown on the empty / post-reply states.
//   • renderMarkdown — a tiny markdown subset for AI replies (fenced code,
//     inline code, headers, bold/italic, lists, paragraphs).
//
// AI_MESSAGES (the active conversation buffer) lives in core/state.js
// because composer auto-translate also reads it. AI_THINKING, SESSION and
// CURRENT_TICKET are imported from core/state.js; TICKETS / CUSTOMERS /
// AGENTS / KB_ARTICLES from core/data.js.
//
// Click handlers route through core/event-delegation.js as `data-action`.
// The textarea keydown handler is wired programmatically inside renderAI
// after innerHTML rebuild (keydown is sparse — 3 callsites in 2 modules —
// not worth a fifth dispatcher event type).
//
// External reaches (interim, via window): escHtml, escAttr — still defined
// inside app.js for now; once core/dom.js extracts the escapers these become
// proper imports. navTo and setSettingsTab are direct ES imports.

import { AGENTS, CUSTOMERS, KB_ARTICLES, TICKETS } from '../core/data.js';
import { AI_MESSAGES, AI_THINKING, SESSION, setAiMessages, setAiThinking } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { AI_API_KEY, AI_MODEL, callClaude } from './client.js';
import { registerActions } from '../core/event-delegation.js';
import { navTo } from '../core/keybindings.js';
import { setSettingsTab } from '../settings/index.js';

let AI_CONTEXT_SOURCES = { tickets:true, customers:false, agents:false, kb:false };
const AI_PROMPT_CARDS = [
  "Summarise today's open tickets and flag any that look urgent",
  "Which categories have the highest ticket volume right now?",
  "Draft a 3-point CSAT improvement plan based on recent tickets",
  "List customers with multiple open tickets and the common themes",
];
const AI_FOLLOWUPS = [
  "Tell me more",
  "Summarise as a bulleted list",
  "What are the next actions?",
  "Show me the ticket IDs",
];

let AI_CONVERSATIONS = (() => {
  try { return JSON.parse(localStorage.getItem('ai_conversations') || '[]'); }
  catch { return []; }
})();
let AI_CURRENT_ID = localStorage.getItem('ai_current_id') || null;
// Hydrate AI_MESSAGES from the persisted current conversation
(function hydrateAIMessages() {
  if (!AI_CURRENT_ID) return;
  const c = AI_CONVERSATIONS.find(x => x.id === AI_CURRENT_ID);
  if (c) setAiMessages([...(c.messages || [])]);
})();

export function renderMarkdown(text) {
  let html = window.escHtml(text);
  // Code blocks (fenced)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h3>$1</h3>');
  // Bold then italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // Bullet lists (consecutive lines starting with - or *)
  html = html.replace(/(?:^[-*] .+(?:\n|$))+/gm, match => {
    const items = match.trim().split('\n').map(l => `<li>${l.replace(/^[-*] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  // Numbered lists
  html = html.replace(/(?:^\d+\. .+(?:\n|$))+/gm, match => {
    const items = match.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });
  // Paragraphs from blank-line splits — wrap chunks not already wrapped in block element
  const blocks = html.split(/\n{2,}/).map(b => {
    const trimmed = b.trim();
    if (!trimmed) return '';
    if (/^<(ul|ol|pre|h[1-6])/.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  });
  return blocks.join('');
}

function saveAIConversations() {
  try {
    localStorage.setItem('ai_conversations', JSON.stringify(AI_CONVERSATIONS));
    if (AI_CURRENT_ID) localStorage.setItem('ai_current_id', AI_CURRENT_ID);
    else localStorage.removeItem('ai_current_id');
  } catch {}
}

function getCurrentAIConv() {
  return AI_CURRENT_ID ? AI_CONVERSATIONS.find(c => c.id === AI_CURRENT_ID) : null;
}

function syncCurrentAIConv() {
  let c = getCurrentAIConv();
  if (!c && AI_MESSAGES.length) {
    // Auto-create a conversation when the user sends without selecting one
    c = { id: 'ai-' + Date.now(), title: 'New chat', messages: [], createdAt: Date.now() };
    AI_CONVERSATIONS.unshift(c);
    AI_CURRENT_ID = c.id;
  }
  if (c) {
    c.messages = [...AI_MESSAGES];
    if (c.title === 'New chat') {
      const first = AI_MESSAGES.find(m => m.r === 'user');
      if (first) c.title = first.t.slice(0, 48) + (first.t.length > 48 ? '…' : '');
    }
    c.updatedAt = Date.now();
    saveAIConversations();
  }
}

function newAIConv() {
  const id = 'ai-' + Date.now();
  AI_CONVERSATIONS.unshift({ id, title: 'New chat', messages: [], createdAt: Date.now() });
  AI_CURRENT_ID = id;
  setAiMessages([]);
  saveAIConversations();
  renderPage('ai');
}

function selectAIConv(id) {
  AI_CURRENT_ID = id;
  const c = getCurrentAIConv();
  setAiMessages(c ? [...(c.messages || [])] : []);
  saveAIConversations();
  renderPage('ai');
}

function deleteAIConv(id) {
  const i = AI_CONVERSATIONS.findIndex(c => c.id === id);
  if (i < 0) return;
  AI_CONVERSATIONS.splice(i, 1);
  if (AI_CURRENT_ID === id) {
    AI_CURRENT_ID = AI_CONVERSATIONS[0]?.id || null;
    const c = getCurrentAIConv();
    setAiMessages(c ? [...(c.messages || [])] : []);
  }
  saveAIConversations();
  renderPage('ai');
}

function copyAIMessage(idx) {
  const m = AI_MESSAGES[idx];
  if (!m) return;
  navigator.clipboard?.writeText(m.t).then(() => {
    const btn = document.getElementById('ai-copy-' + idx);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = original; }, 1200);
    }
  });
}

function useFollowUp(text) {
  const input = document.getElementById('ai-input');
  if (input) { input.value = text; input.focus(); }
}

export function renderAI() {
  const empty = AI_MESSAGES.length === 0;
  const sources = [
    {k:'tickets',   l:`Tickets · ${TICKETS.length}`},
    {k:'customers', l:`Customers · ${CUSTOMERS.length}`},
    {k:'agents',    l:`Agents · ${AGENTS.length}`},
    {k:'kb',        l:`KB · ${KB_ARTICLES.length}`},
  ];
  const chips = sources.map(s => `<span class="source-chip ${AI_CONTEXT_SOURCES[s.k]?'on':''}" data-action="ai.toggleSource" data-source="${s.k}" style="cursor:pointer">${s.l}</span>`).join('');
  const noKeyMsg = AI_API_KEY ? '' : ` Add a Claude API key in <span class="link" data-action="ai.gotoSettingsAi">Settings → AI Assistant</span> to get started.`;

  const msgs = AI_MESSAGES.map((m, i) => {
    const body = m.r === 'user'
      ? `<div style="white-space:pre-wrap;word-wrap:break-word">${window.escHtml(m.t)}</div>`
      : `<div class="ai-md">${renderMarkdown(m.t)}</div>`;
    return `
      <div class="ai-msg ai-msg-${m.r==='user'?'user':'ai'}">
        <div class="ai-msg-from">${m.r==='user' ? window.escHtml(SESSION?.name||'You') : 'AI Assistant'}</div>
        ${body}
        ${m.r === 'ai' ? `<button class="ai-msg-copy" id="ai-copy-${i}" data-action="ai.copyMessage" data-idx="${i}">Copy</button>` : ''}
      </div>`;
  }).join('');

  const thinkingMsg = AI_THINKING ? `
    <div class="ai-msg ai-msg-ai">
      <div class="ai-msg-from">AI Assistant</div>
      <div style="display:flex;gap:4px;align-items:center;color:var(--purple);font-size:18px;line-height:1"><span class="dot">·</span><span class="dot">·</span><span class="dot">·</span></div>
    </div>` : '';

  const last = AI_MESSAGES[AI_MESSAGES.length - 1];
  const showFollowUps = last && last.r === 'ai' && !AI_THINKING;
  const followUpsHtml = showFollowUps ? `
    <div class="ai-followups">
      ${AI_FOLLOWUPS.map(f => `<span class="ai-followup" data-action="ai.useFollowUp" data-text="${window.escAttr(f)}">${f}</span>`).join('')}
    </div>` : '';

  const sortedConvs = [...AI_CONVERSATIONS].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  const convList = sortedConvs.length
    ? sortedConvs.map(c => `
        <div class="ai-conv-item ${c.id===AI_CURRENT_ID?'active':''}" data-action="ai.selectConv" data-id="${window.escAttr(c.id)}">
          <div class="ai-conv-title" title="${window.escHtml(c.title)}">${window.escHtml(c.title)}</div>
          <button class="ai-conv-del" data-action="ai.deleteConv" data-id="${window.escAttr(c.id)}" title="Delete">×</button>
        </div>`).join('')
    : '<div class="ai-conv-empty">No conversations yet — send a message to start one.</div>';

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">AI Intelligence</div>
        ${AI_MESSAGES.length ? `<button class="btn btn-sm" data-action="ai.clear">Clear chat</button>` : ''}
        <span style="font-size:11px;color:${AI_API_KEY?'var(--green)':'var(--amber)'};font-family:'DM Mono',monospace;display:flex;align-items:center;gap:6px;margin-left:auto">
          <span style="width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 6px currentColor"></span>
          ${AI_API_KEY ? `${AI_MODEL || 'claude-sonnet-4-6'}` : 'No API key'}
        </span>
      </div>
      <div class="ai-layout">
        <aside class="ai-sidebar">
          <div class="ai-sidebar-header">
            <button class="btn btn-solid btn-sm" data-action="ai.newConv" style="width:100%;justify-content:center">+ New chat</button>
          </div>
          <div class="ai-conv-list">${convList}</div>
        </aside>
        <div class="ai-main">
          <div class="filter-bar">
            <span class="filter-label">Context</span>
            ${chips}
            <span style="font-size:11px;color:var(--ink3);margin-left:auto">Toggle which workspace data the AI can see</span>
          </div>
          ${empty ? `
            <div class="page-scroll" style="padding:48px 20px">
              <div style="max-width:680px;margin:0 auto;text-align:center">
                <div style="font-family:'Inter',sans-serif;font-size:24px;font-weight:700;letter-spacing:-.02em;color:var(--ink);margin-bottom:8px">How can I help?</div>
                <div style="font-size:13px;color:var(--ink3);margin-bottom:28px">Ask about your workspace data — tickets, customers, agents or knowledge base.${noKeyMsg}</div>
              </div>
              <div class="prompt-cards" style="justify-content:center;padding:0">
                ${AI_PROMPT_CARDS.map(p => `<div class="prompt-card" data-action="ai.usePrompt" data-text="${window.escAttr(p)}">${p}</div>`).join('')}
              </div>
            </div>
          ` : `<div class="ai-chat" id="ai-chat">${msgs}${thinkingMsg}</div>${followUpsHtml}`}
          <div class="ai-input-row">
            <textarea id="ai-input" placeholder="${AI_API_KEY?'Ask about your workspace… (Enter to send, Shift+Enter for new line)':'Add an API key in Settings → AI Assistant to chat'}" style="flex:1;font-family:'Inter',sans-serif;font-size:13px;line-height:1.5;color:var(--ink);background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);padding:9px 12px;resize:none;outline:none;height:46px" ${AI_THINKING?'disabled':''}></textarea>
            <button class="btn btn-solid" data-action="ai.send" ${AI_THINKING?'disabled':''}>${AI_THINKING?'…':'Send'}</button>
          </div>
        </div>
      </div>
    </div>`;
}

function aiToggleSource(k) {
  AI_CONTEXT_SOURCES[k] = !AI_CONTEXT_SOURCES[k];
  renderPage('ai');
}

function aiUsePrompt(p) {
  const input = document.getElementById('ai-input');
  if (input) { input.value = p; input.focus(); }
}

function aiClear() {
  setAiMessages([]);
  const c = getCurrentAIConv();
  if (c) { c.messages = []; saveAIConversations(); }
  renderPage('ai');
}

function aiInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    aiSend();
  }
}

function scrollAIBottom() {
  const chat = document.getElementById('ai-chat');
  if (chat) chat.scrollTop = chat.scrollHeight;
}

function buildAIContext() {
  const parts = [];
  if (AI_CONTEXT_SOURCES.tickets) {
    parts.push(`TICKETS (${TICKETS.length}):\n` + TICKETS.map(t => {
      const c = CUSTOMERS.find(x => x.id === t.customerId);
      return `- ${t.id}: "${t.subject}" | status=${t.status} | priority=${t.priority} | category=${t.category} | sla=${t.sla} | agent=${t.agent} | customer=${c?c.first+' '+c.last:t.customerId} | tags=[${t.tags.join(',')}] | csat=${t.csat??'n/a'}`;
    }).join('\n'));
  }
  if (AI_CONTEXT_SOURCES.customers) {
    parts.push(`CUSTOMERS (${CUSTOMERS.length}):\n` + CUSTOMERS.map(c =>
      `- ${c.id}: ${c.first} ${c.last} | brand=${c.brand} | vip=${c.vip} | jurisdiction=${c.jurisdiction} | kyc=${c.kyc} | consent=${c.consent} | since=${c.since}`
    ).join('\n'));
  }
  if (AI_CONTEXT_SOURCES.agents) {
    parts.push(`AGENTS (${AGENTS.length}):\n` + AGENTS.map(a =>
      `- ${a.name} (${a.initials}) | role=${a.role} | active=${a.active}`
    ).join('\n'));
  }
  if (AI_CONTEXT_SOURCES.kb) {
    parts.push(`KNOWLEDGE BASE (${KB_ARTICLES.length}):\n` + KB_ARTICLES.map(a =>
      `- ${a.id}: "${a.title}" | category=${a.category}`
    ).join('\n'));
  }
  return parts.length ? parts.join('\n\n') : 'No workspace data context selected.';
}

async function aiSend() {
  if (AI_THINKING) return;
  const input = document.getElementById('ai-input');
  const text = input?.value.trim();
  if (!text) return;

  AI_MESSAGES.push({r:'user', t:text});
  if (input) input.value = '';
  syncCurrentAIConv();

  if (!AI_API_KEY) {
    AI_MESSAGES.push({r:'ai', t:'No Claude API key configured. Add one in Settings → AI Assistant to enable the assistant.'});
    syncCurrentAIConv();
    renderPage('ai');
    return;
  }

  setAiThinking(true);
  renderPage('ai');

  const ctx = buildAIContext();
  const conv = AI_MESSAGES
    .filter(m => m.r === 'user' || m.r === 'ai')
    .map(m => ({ role: m.r === 'user' ? 'user' : 'assistant', content: m.t }));

  try {
    const { text, error } = await callClaude({
      system: `You are an AI analyst embedded in Maestro Desk, a customer-support app. Answer questions about the workspace data provided below. Be concise and concrete — when you reference tickets, customers or agents, use their identifiers (e.g. TK-001, M003). If a question can't be answered from the data provided, say so plainly.\n\n${ctx}`,
      messages: conv,
      maxTokens: 1024,
    });
    const reply = text || error || 'Could not generate a response.';
    AI_MESSAGES.push({r:'ai', t:reply});
  } catch (e) {
    AI_MESSAGES.push({r:'ai', t:'AI unavailable: ' + (e?.message || 'network error')});
  }
  setAiThinking(false);
  syncCurrentAIConv();
  renderPage('ai');
}

export function initAI() {
  scrollAIBottom();
  const input = document.getElementById('ai-input');
  if (input) {
    input.addEventListener('keydown', aiInputKey);
    if (!AI_THINKING) input.focus();
  }
}

registerActions({
  'ai.toggleSource':    (ds) => aiToggleSource(ds.source),
  'ai.gotoSettingsAi':  () => { navTo('settings'); setSettingsTab('ai'); },
  'ai.copyMessage':     (ds) => copyAIMessage(parseInt(ds.idx, 10)),
  'ai.useFollowUp':     (ds) => useFollowUp(ds.text),
  'ai.selectConv':      (ds) => selectAIConv(ds.id),
  'ai.deleteConv':      (ds) => deleteAIConv(ds.id),
  'ai.clear':           () => aiClear(),
  'ai.newConv':         () => newAIConv(),
  'ai.usePrompt':       (ds) => aiUsePrompt(ds.text),
  'ai.send':            () => aiSend(),
});
