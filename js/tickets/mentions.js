// ─── @mentions ───────────────────────────────────────────────────────────────
// Parse @Full Name tokens out of an internal note's body, returning the array
// of agent names that actually exist. Used both at submit time (to seed the
// message's mentions array for notifications) and during render to highlight
// the @-tokens with the `.mention` / `.mention.self` CSS classes.
//
// The composer-side typeahead dropdown — updateMentionDropdown / insertMention
// / mentionDropdownKey — lives here too. The dropdown owns its own internal
// state (MENTION_DD_*); it manipulates the DOM directly via #mention-dd.
//
// External reach (interim, via window): escHtml, escAttr. onComposeInput
// is a direct ES import from tickets/detail.js. AGENTS (core/data.js) and
// SESSION (core/state.js) are imported.
//
// No window-bridge namespace: parse/render + the dropdown lifecycle
// (updateMentionDropdown/hideMentionDropdown/mentionDropdownKey) are
// consumed by tickets/detail.js via direct ES import. The dropdown items'
// only inline handler is delegated as mentions.insert below — kept on
// `mousedown` (not click) so it fires before the compose textarea's
// focusout hides the dropdown (detail.js delays hide by 150ms).

import { AGENTS } from '../core/data.js';
import { SESSION } from '../core/state.js';
import { registerMousedownActions } from '../core/event-delegation.js';
import { onComposeInput } from './detail.js';

export function parseMentions(text) {
  const out = [];
  if (!text) return out;
  // Match longer names first so "Tom Bates Jr" wins over "Tom Bates" if both exist.
  const names = AGENTS.map(a => a.name).sort((a, b) => b.length - a.length);
  for (const name of names) {
    const re = new RegExp('(^|[^A-Za-z0-9_@])@' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_])');
    if (re.test(text) && !out.includes(name)) out.push(name);
  }
  return out;
}

export function renderTextWithMentions(text) {
  // Scan the ORIGINAL (unescaped) text for mention positions, then build the
  // output by escaping segments between mentions independently. Avoids the
  // class of bug where regex over already-escaped HTML can interleave a span
  // into the middle of an entity (&amp;, &lt;, etc).
  if (!text) return '';
  const me = SESSION?.name;
  const names = AGENTS.map(a => a.name).sort((a, b) => b.length - a.length);
  const isWord = c => /[A-Za-z0-9_]/.test(c);
  const found = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '@' && (i === 0 || !isWord(text[i - 1]))) {
      let matched = null;
      for (const name of names) {
        if (text.slice(i + 1, i + 1 + name.length) === name) {
          const after = text[i + 1 + name.length] || '';
          if (!isWord(after)) { matched = name; break; }
        }
      }
      if (matched) {
        found.push({ pos: i, name: matched });
        i += 1 + matched.length;
        continue;
      }
    }
    i++;
  }
  if (!found.length) return window.escHtml(text).replace(/\n/g, '<br>');
  let out = '';
  let pos = 0;
  for (const m of found) {
    out += window.escHtml(text.slice(pos, m.pos));
    const cls = m.name === me ? 'mention self' : 'mention';
    out += `<span class="${cls}">@${window.escHtml(m.name)}</span>`;
    pos = m.pos + 1 + m.name.length;
  }
  out += window.escHtml(text.slice(pos));
  return out.replace(/\n/g, '<br>');
}

let MENTION_DD_ACTIVE_INDEX = 0;
let MENTION_DD_MATCHES = [];

export function updateMentionDropdown(ticketId, el) {
  const cursor = el.selectionStart || 0;
  const before = el.value.slice(0, cursor);
  // Match an @-token at the cursor: optional preceding space/start, '@', then up to one word.
  const m = before.match(/(?:^|\s)@([A-Za-z]*)$/);
  if (!m) { hideMentionDropdown(); return; }
  const query = m[1].toLowerCase();
  const matches = AGENTS
    .map(a => a.name)
    .filter(name => name !== SESSION?.name)
    .filter(name => name.toLowerCase().includes(query))
    .slice(0, 6);
  MENTION_DD_MATCHES = matches;
  MENTION_DD_ACTIVE_INDEX = 0;
  showMentionDropdown(ticketId, el, matches, query);
}

function showMentionDropdown(ticketId, el, matches, query) {
  let dd = document.getElementById('mention-dd');
  if (!dd) {
    dd = document.createElement('div');
    dd.id = 'mention-dd';
    dd.className = 'mention-dd';
    document.body.appendChild(dd);
  }
  if (!matches.length) {
    dd.innerHTML = `<div class="mention-dd-empty">No agents match "${window.escHtml(query)}"</div>`;
  } else {
    dd.innerHTML = matches.map((name, i) => `
      <div class="mention-dd-item ${i === MENTION_DD_ACTIVE_INDEX ? 'active' : ''}" data-mousedown-action="mentions.insert" data-ticket-id="${window.escAttr(ticketId)}" data-idx="${i}">
        <span style="width:20px;height:20px;border-radius:50%;background:var(--ink);color:var(--w);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;flex-shrink:0">${window.escHtml(name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase())}</span>
        <span>${window.escHtml(name)}</span>
      </div>`).join('');
  }
  // Position above the textarea (simple anchoring; matches the modal-portal approach used elsewhere).
  const r = el.getBoundingClientRect();
  dd.style.left = `${Math.round(r.left)}px`;
  dd.style.top  = `${Math.round(r.bottom + 4)}px`;
  dd.style.display = 'block';
}

export function hideMentionDropdown() {
  const dd = document.getElementById('mention-dd');
  if (dd) dd.style.display = 'none';
  MENTION_DD_MATCHES = [];
}

function insertMention(ticketId, idx) {
  const name = MENTION_DD_MATCHES[idx];
  const el = document.getElementById('compose-' + ticketId);
  if (!el || !name) return;
  const cursor = el.selectionStart || 0;
  const before = el.value.slice(0, cursor);
  const after  = el.value.slice(cursor);
  // Replace the @partial at cursor with @Full Name plus a trailing space.
  const replaced = before.replace(/@([A-Za-z]*)$/, `@${name} `);
  el.value = replaced + after;
  const newPos = replaced.length;
  el.focus();
  el.setSelectionRange(newPos, newPos);
  hideMentionDropdown();
  onComposeInput(ticketId);
}

export function mentionDropdownKey(e, ticketId) {
  const dd = document.getElementById('mention-dd');
  if (!dd || dd.style.display === 'none' || !MENTION_DD_MATCHES.length) return false;
  if (e.key === 'ArrowDown') {
    MENTION_DD_ACTIVE_INDEX = (MENTION_DD_ACTIVE_INDEX + 1) % MENTION_DD_MATCHES.length;
    e.preventDefault();
    updateMentionDDActive();
    return true;
  }
  if (e.key === 'ArrowUp') {
    MENTION_DD_ACTIVE_INDEX = (MENTION_DD_ACTIVE_INDEX - 1 + MENTION_DD_MATCHES.length) % MENTION_DD_MATCHES.length;
    e.preventDefault();
    updateMentionDDActive();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    insertMention(ticketId, MENTION_DD_ACTIVE_INDEX);
    return true;
  }
  if (e.key === 'Escape') {
    hideMentionDropdown();
    return true;
  }
  return false;
}

function updateMentionDDActive() {
  const items = document.querySelectorAll('#mention-dd .mention-dd-item');
  items.forEach((el, i) => el.classList.toggle('active', i === MENTION_DD_ACTIVE_INDEX));
}

registerMousedownActions({
  'mentions.insert': (ds) => insertMention(ds.ticketId, parseInt(ds.idx, 10)),
});
