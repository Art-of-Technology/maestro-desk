// ─── Settings ────────────────────────────────────────────────────────────────
// Six-tab settings page: Profile, Appearance, Notifications, AI Assistant,
// Knowledge Base, Language. The "Knowledge Base" tab configures the
// KB_INTEGRATION object that lives in app.js — the rest of the KB
// integration code (fetchKbArticles, KB_TICKET_CACHE, refresh path) stays
// in app.js because the composer and ticket sidebar also depend on it.
//
// External reaches (interim, via window): isAdmin, escAttr, escHtml,
// showModal, closeModal, renderPage, navTo, logout,
// resetAllCollapsedSections — all still in app.js. KB_INTEGRATION,
// KB_TICKET_CACHE, saveKbIntegration, fetchKbArticles, COLLAPSED_SECTIONS
// are bridged onto window by app.js so this module can read/mutate them.
// refreshNotifBadge is a direct ES import from notifications/index.js.
//
// SESSION, SETTINGS_TAB, NOTIF_PREFS come from core/state.js via the global
// lexical env.

import { THEME, setTheme } from '../core/theme.js';
import { AI_API_KEY, AI_MODEL, setAIKey, setAIModel } from '../ai/client.js';
import {
  AGENT_PREFERRED_LANG, TRANSLATOR_LANGS, setAgentPreferredLang,
} from '../ai/translate.js';
import { refreshNotifBadge } from '../notifications/index.js';
import { apiGet, apiPut, apiDelete } from '../core/api-client.js';

// In-memory snapshot of the workspace's Slack integration, loaded lazily
// when the Integrations tab is opened.
let SLACK_INTEGRATION = null;
let SLACK_LOADED = false;
const SLACK_EVENTS = [
  { k: 'ticket.created',   l: 'Ticket created' },
  { k: 'ticket.resolved',  l: 'Ticket resolved' },
  { k: 'ticket.escalated', l: 'Ticket escalated' },
  { k: 'priority.urgent',  l: 'Priority set to urgent' },
];

// Module-scoped state for the Settings → Knowledge Base test panel. Kept off
// `window` so it doesn't pollute the global namespace.
let KB_TEST_STATE = null;

export function renderSettings() {
  const tabs = [
    {k:'profile',       l:'Profile'},
    {k:'appearance',    l:'Appearance'},
    {k:'notifications', l:'Notifications'},
    {k:'ai',            l:'AI Assistant'},
    {k:'knowledge-base', l:'Knowledge Base'},
    {k:'language',      l:'Language'},
    {k:'integrations',  l:'Integrations'},
  ];
  const tabbar = tabs.map(t => `<div class="settings-tab ${SETTINGS_TAB===t.k?'active':''}" onclick="setSettingsTab('${t.k}')">${t.l}</div>`).join('');
  let panel = '';
  if      (SETTINGS_TAB === 'profile')       panel = settingsProfile();
  else if (SETTINGS_TAB === 'appearance')    panel = settingsAppearance();
  else if (SETTINGS_TAB === 'notifications') panel = settingsNotifications();
  else if (SETTINGS_TAB === 'ai')            panel = settingsAI();
  else if (SETTINGS_TAB === 'knowledge-base') panel = settingsKnowledgeBase();
  else if (SETTINGS_TAB === 'language')      panel = settingsLanguage();
  else if (SETTINGS_TAB === 'integrations')  panel = settingsIntegrations();
  return `
    <div class="page">
      <div class="topbar"><div class="tb-title">Settings</div></div>
      <div class="page-scroll">
        <div class="settings-shell">
          <aside class="settings-side">${tabbar}</aside>
          <div class="settings-panel">${panel}</div>
        </div>
      </div>
    </div>`;
}

export function setSettingsTab(k) { SETTINGS_TAB = k; window.renderPage('settings'); }

function settingsProfile() {
  return `
    <div class="settings-section">
      <div class="settings-h">Account</div>
      <div style="display:flex;gap:12px;align-items:center;padding:8px 0 18px;border-bottom:1px solid var(--rule);margin-bottom:18px">
        <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;font-size:14px">${SESSION?.initials||'??'}</div>
        <div>
          <div style="font-size:15px;font-weight:600;color:var(--ink)">${SESSION?.name||'—'}</div>
          <div style="font-size:12px;color:var(--ink3)">${SESSION?.role||'—'}</div>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">Display name</label>
        <input class="form-input" id="set-name" value="${SESSION?.name||''}" oninput="updateProfileName(this.value)"/>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">Initials</label>
          <input class="form-input" id="set-initials" value="${SESSION?.initials||''}" maxlength="3" oninput="updateProfileInitials(this.value)"/>
        </div>
        <div class="form-row">
          <label class="form-label">Role</label>
          <input class="form-input" value="${SESSION?.role||''}" disabled style="opacity:.6"/>
        </div>
      </div>
      <div style="margin-top:16px"><button class="btn btn-danger" onclick="logout()">Sign out</button></div>
    </div>`;
}

export function updateProfileName(name) {
  const trimmed = name.trim();
  if (!SESSION || !trimmed) return;
  SESSION.name = trimmed;
  const a = document.getElementById('sb-uname');   if (a) a.textContent = trimmed;
  const b = document.getElementById('sf-name');    if (b) b.textContent = trimmed;
  const c = document.getElementById('pf-name-sm'); if (c) c.textContent = trimmed;
  const d = document.getElementById('pf-name-lg'); if (d) d.textContent = trimmed;
}
export function updateProfileInitials(v) {
  const trimmed = v.trim().toUpperCase();
  if (!SESSION || !trimmed) return;
  SESSION.initials = trimmed;
  const av  = document.getElementById('sb-av');    if (av)  av.textContent  = trimmed;
  const av2 = document.getElementById('pf-av-sm'); if (av2) av2.textContent = trimmed;
  const av3 = document.getElementById('pf-av-lg'); if (av3) av3.textContent = trimmed;
}

function settingsAppearance() {
  const isSystem = THEME === 'system';
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = THEME === 'dark' || (isSystem && sysDark);
  const fallback = isDark ? 'dark' : 'light';
  const collapsedN = window.COLLAPSED_SECTIONS?.size || 0;
  return `
    <div class="settings-section">
      <div class="settings-h">Theme</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Light or dark palette, or follow your operating system.</div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Dark mode</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">Use a darker color palette across the app${isSystem?' — currently controlled by system preference':''}</div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${isDark?'checked':''} ${isSystem?'disabled':''} onchange="setTheme(this.checked?'dark':'light');renderPage('settings')">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Match system preference</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">Automatically switch when your operating system changes themes</div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${isSystem?'checked':''} onchange="setTheme(this.checked?'system':'${fallback}');renderPage('settings')">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-h">Page chrome</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Click the small caret in the top-right of any KPI bar, filter bar, or tab bar to collapse it. Collapsed sections shrink to a one-line "▸ Show …" pill — click anywhere on the pill to expand again. Choices stick across reloads.</div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Hidden sections</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">${collapsedN} section${collapsedN===1?'':'s'} collapsed across pages</div>
        </div>
        <button class="btn btn-sm" ${collapsedN===0?'disabled':''} onclick="resetAllCollapsedSections()">Show all</button>
      </div>
    </div>`;
}

function settingsNotifications() {
  const types = [
    {k:'breach',    l:'SLA breach',    d:'Tickets that have exceeded their SLA window'},
    {k:'escalated', l:'Escalations',   d:'Tickets escalated to senior agents'},
    {k:'gdpr',      l:'GDPR requests', d:'Data subject access and erasure requests'},
    {k:'warn',      l:'SLA warnings',  d:'Tickets approaching SLA breach'},
    {k:'wake',      l:'Snooze wake-ups', d:'Tickets that have come back from a snooze'},
    {k:'mention',   l:'@mentions',     d:'You were @-mentioned in an internal note'},
  ];
  return `
    <div class="settings-section">
      <div class="settings-h">Notification types</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Choose which alerts appear in the notifications bell.</div>
      ${types.map(t => `
        <div class="settings-row">
          <div>
            <div style="font-size:13px;font-weight:500;color:var(--ink)">${t.l}</div>
            <div style="font-size:11px;color:var(--ink3);margin-top:2px">${t.d}</div>
          </div>
          <label class="toggle">
            <input type="checkbox" ${NOTIF_PREFS[t.k]?'checked':''} onchange="toggleNotifPref('${t.k}',this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>`).join('')}
    </div>`;
}

export function toggleNotifPref(k, v) {
  NOTIF_PREFS[k] = v;
  localStorage.setItem('notif_prefs', JSON.stringify(NOTIF_PREFS));
  refreshNotifBadge();
}

function settingsAI() {
  const models = [
    {v:'claude-opus-4-7',  l:'Claude Opus 4.7'},
    {v:'claude-sonnet-4-6',l:'Claude Sonnet 4.6'},
    {v:'claude-haiku-4-5', l:'Claude Haiku 4.5'},
  ];
  return `
    <div class="settings-section">
      <div class="settings-h">Claude API</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Used by the <strong style="color:var(--ink2)">AI Draft</strong> button in the ticket composer. Stored locally in your browser — never sent to our servers.</div>
      <div class="form-row">
        <label class="form-label">API key</label>
        <input class="form-input" type="password" id="set-ai-key" value="${AI_API_KEY}" placeholder="sk-ant-…" oninput="setAIKey(this.value)" autocomplete="off"/>
      </div>
      <div class="form-row">
        <label class="form-label">Model</label>
        <select class="form-input" onchange="setAIModel(this.value)">
          ${models.map(m => `<option value="${m.v}" ${AI_MODEL===m.v?'selected':''}>${m.l}</option>`).join('')}
        </select>
      </div>
      <div style="font-size:11px;color:${AI_API_KEY?'var(--green)':'var(--ink3)'};font-family:'DM Mono',monospace;margin-top:8px">
        ${AI_API_KEY ? '✓ Key saved' : 'No key configured — AI Draft will return a fallback message'}
      </div>
    </div>`;
}

function settingsKnowledgeBase() {
  const cfg = window.KB_INTEGRATION;
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const testState = KB_TEST_STATE || null;
  return `
    <div class="settings-section">
      <div class="settings-h">External Knowledge Base</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Connect a third-party KB so the composer can ground AI replies in your own articles. Configure the endpoint + JSON field mapping; the adapter is generic and works with any REST API that returns a list of articles per query.</div>
      <div style="font-size:11px;color:var(--amber);background:var(--amber-lt);border:1px solid var(--amber);border-radius:var(--r);padding:8px 10px;margin-bottom:14px;line-height:1.5">
        <strong>Security notes.</strong> The API key is held in browser <code style="font-family:'DM Mono',monospace">localStorage</code> on this device — anyone with access to this browser profile can read it. Point the base URL at an external KB only; internal IPs or non-HTTPS hosts are blocked from most browser fetch contexts and shouldn't be used. Audit your KB content for prompt-injection — KB excerpts are clearly marked as untrusted data when sent to Claude, but reviewers should still vet what the model can see.
      </div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Integration enabled</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">When on, the composer shows an "AI Reply with KB" action and the ticket sidebar lists matching articles.</div>
        </div>
        <label class="toggle"><input type="checkbox" ${cfg.enabled?'checked':''} onchange="setKbCfg('enabled',this.checked)"><span class="toggle-slider"></span></label>
      </div>
      <div class="form-row"><label class="form-label">Base URL</label>
        <input class="form-input" id="kb-base-url" placeholder="https://kb.example.com/api/v1" value="${esc(cfg.baseUrl)}" oninput="setKbCfg('baseUrl',this.value)"/>
      </div>
      <div class="form-row"><label class="form-label">Search path <span style="color:var(--ink3);font-family:'DM Mono',monospace;font-size:11px;font-weight:400">— use {query} as placeholder</span></label>
        <input class="form-input" id="kb-search-path" placeholder="/articles?q={query}&amp;limit=5" value="${esc(cfg.searchPath)}" oninput="setKbCfg('searchPath',this.value)"/>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Auth header (optional)</label>
          <input class="form-input" placeholder="Authorization" value="${esc(cfg.authHeader)}" oninput="setKbCfg('authHeader',this.value)"/>
        </div>
        <div class="form-row"><label class="form-label">Header prefix</label>
          <input class="form-input" placeholder="Bearer " value="${esc(cfg.authPrefix)}" oninput="setKbCfg('authPrefix',this.value)"/>
        </div>
      </div>
      <div class="form-row"><label class="form-label">API key / token (optional)</label>
        <input class="form-input" type="password" placeholder="—" value="${esc(cfg.apiKey)}" oninput="setKbCfg('apiKey',this.value)" autocomplete="off"/>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-h">Response shape</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Tell the adapter where to find articles inside the JSON response. Field names support dot notation (e.g. <code style="font-family:'DM Mono',monospace">data.items</code>).</div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Results path</label>
          <input class="form-input" placeholder="(empty = response root)" value="${esc(cfg.resultsField)}" oninput="setKbCfg('resultsField',this.value)"/>
        </div>
        <div class="form-row"><label class="form-label">Max results</label>
          <input class="form-input" type="number" min="1" max="20" value="${cfg.maxResults}" oninput="setKbCfg('maxResults',parseInt(this.value,10)||3)"/>
        </div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">ID field</label><input class="form-input" value="${esc(cfg.idField)}" oninput="setKbCfg('idField',this.value)"/></div>
        <div class="form-row"><label class="form-label">Title field</label><input class="form-input" value="${esc(cfg.titleField)}" oninput="setKbCfg('titleField',this.value)"/></div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Body field</label><input class="form-input" value="${esc(cfg.bodyField)}" oninput="setKbCfg('bodyField',this.value)"/></div>
        <div class="form-row"><label class="form-label">URL field</label><input class="form-input" value="${esc(cfg.urlField)}" oninput="setKbCfg('urlField',this.value)"/></div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-h">Test connection</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Send a sample query against the configured endpoint to verify the path, auth, and field mapping.</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="form-input" id="kb-test-q" placeholder="e.g. password reset" style="flex:1;min-width:200px" value="${esc(testState?.query || 'password reset')}"/>
        <button class="btn btn-sm" onclick="testKbConnection()" ${cfg.enabled?'':'disabled'}>Run test</button>
      </div>
      ${testState ? `
        <div style="margin-top:14px;padding:12px;border:1px solid ${testState.error?'var(--red)':'var(--green)'};border-radius:var(--r);background:${testState.error?'var(--red-lt)':'var(--green-lt)'}">
          ${testState.error ? `<div style="font-size:12px;color:var(--red);font-family:'DM Mono',monospace">${window.escHtml(testState.error)}</div>` : `
            <div style="font-size:12px;color:var(--green);font-weight:500;margin-bottom:8px">✓ ${testState.articles.length} article${testState.articles.length===1?'':'s'} returned</div>
            ${testState.articles.map(a => `<div style="padding:6px 8px;background:var(--off);border:1px solid var(--rule);border-radius:3px;margin-bottom:4px"><div style="font-size:12px;font-weight:500;color:var(--ink)">${window.escHtml(a.title)}</div><div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${window.escHtml(a.id)} · ${window.escHtml(a.url || '(no url)')}</div></div>`).join('')}
          `}
        </div>` : ''}
    </div>`;
}

export function setKbCfg(key, value) {
  window.KB_INTEGRATION[key] = value;
  window.saveKbIntegration();
  window.KB_TICKET_CACHE.clear();
}

export async function testKbConnection() {
  const q = document.getElementById('kb-test-q')?.value?.trim() || 'password reset';
  KB_TEST_STATE = { query: q, loading: true };
  window.renderPage('settings');
  const result = await window.fetchKbArticles(q);
  KB_TEST_STATE = { query: q, articles: result.articles || [], error: result.error || null };
  window.renderPage('settings');
}

function settingsLanguage() {
  return `
    <div class="settings-section">
      <div class="settings-h">Your reading language</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">When ticket-thread translation is enabled (toggle above the conversation), customer messages render in this language. Replies you compose can also be auto-translated to the customer's language before sending. Detection and translation use the Claude API key configured in <span class="link" onclick="setSettingsTab('ai')">AI Assistant</span>.</div>
      <div class="form-row">
        <label class="form-label">Preferred language</label>
        <select class="form-input" id="set-pref-lang" onchange="setAgentPreferredLang(this.value)">
          ${TRANSLATOR_LANGS.map(l => `<option value="${l}" ${AGENT_PREFERRED_LANG===l?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>
      <div style="font-size:11px;color:${AI_API_KEY?'var(--green)':'var(--amber)'};font-family:'DM Mono',monospace;margin-top:8px">
        ${AI_API_KEY ? `✓ Currently set to ${AGENT_PREFERRED_LANG}` : 'Add an API key in AI Assistant to enable detection and translation.'}
      </div>
    </div>`;
}

// ─── Integrations panel (Slack) ──────────────────────────────────────────
function settingsIntegrations() {
  // Lazy load on first paint; trigger a re-render when the fetch lands.
  if (!SLACK_LOADED) {
    SLACK_LOADED = true;
    apiGet('/api/v1/integrations/slack')
      .then((res) => { SLACK_INTEGRATION = res.integration; window.renderPage('settings'); })
      .catch((err) => { console.warn('[settings] slack load failed:', err); });
  }
  const slack = SLACK_INTEGRATION;
  const events = slack?.events || ['ticket.resolved', 'ticket.escalated'];
  const checkbox = (k, l) => `
    <label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px">
      <input type="checkbox" id="slack-evt-${k}" ${events.includes(k) ? 'checked' : ''}/>
      ${window.escHtml(l)}
    </label>`;
  return `
    <div class="settings-section">
      <div class="settings-h">Slack</div>
      <div class="settings-desc" style="margin-bottom:14px">
        Post a message to a Slack channel when key ticket events fire.
        Paste your Slack <a href="https://api.slack.com/messaging/webhooks" target="_blank" style="color:var(--purple)">incoming-webhook URL</a> — it's the secret, so treat it like a password.
      </div>
      <div class="form-row">
        <label class="form-label">Webhook URL</label>
        <input class="form-input" id="slack-url" type="url" value="${window.escAttr(slack?.webhook_url || '')}" placeholder="https://hooks.slack.com/services/..." autocomplete="off"/>
      </div>
      <div class="form-row">
        <label class="form-label">Channel override (optional)</label>
        <input class="form-input" id="slack-channel" value="${window.escAttr(slack?.channel || '')}" placeholder="#support"/>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Leave blank to use the channel the webhook is bound to in Slack.</div>
      </div>
      <div class="form-row">
        <label class="form-label">Events</label>
        ${SLACK_EVENTS.map((e) => checkbox(e.k, e.l)).join('')}
      </div>
      <div class="form-row" style="display:flex;align-items:center;gap:8px">
        <label class="toggle"><input type="checkbox" id="slack-active" ${slack?.active !== false ? 'checked' : ''}/><span class="toggle-slider"></span></label>
        <span style="font-size:13px;color:var(--ink2)">Active</span>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-solid btn-sm" onclick="saveSlackIntegration()">Save</button>
        ${slack ? '<button class="btn btn-sm btn-danger" onclick="deleteSlackIntegration()">Disconnect</button>' : ''}
        <span id="slack-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace"></span>
      </div>
    </div>`;
}

export async function saveSlackIntegration() {
  if (!window.isAdmin()) return;
  const url     = document.getElementById('slack-url').value.trim();
  const channel = document.getElementById('slack-channel').value.trim();
  const active  = document.getElementById('slack-active').checked;
  const events  = SLACK_EVENTS.filter((e) => document.getElementById(`slack-evt-${e.k}`)?.checked).map((e) => e.k);
  const msg = document.getElementById('slack-msg');
  if (!url) { msg.textContent = 'Webhook URL is required'; msg.style.color = 'var(--red)'; return; }
  if (events.length === 0) { msg.textContent = 'Pick at least one event'; msg.style.color = 'var(--red)'; return; }
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPut('/api/v1/integrations/slack', {
      webhook_url: url,
      channel:     channel || null,
      active,
      events,
    });
    SLACK_INTEGRATION = res.integration;
    msg.textContent = 'Saved'; msg.style.color = 'var(--green)';
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

export async function deleteSlackIntegration() {
  if (!window.isAdmin()) return;
  if (!confirm('Disconnect Slack? Future ticket events won\'t notify until you reconnect.')) return;
  try {
    await apiDelete('/api/v1/integrations/slack');
    SLACK_INTEGRATION = null;
    window.renderPage('settings');
  } catch (err) {
    alert(`Couldn't disconnect: ${err?.message || err}`);
  }
}
