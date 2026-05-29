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
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, API_BASE } from '../core/api-client.js';
import { showModal } from '../core/modal.js';

// In-memory snapshots of the workspace's integrations, loaded lazily
// when the Integrations tab is opened.
let SLACK_INTEGRATION = null;
let SLACK_LOADED = false;
let STRIPE_INTEGRATION = null;
let STRIPE_LOADED = false;
let SHOPIFY_INTEGRATION = null;
let SHOPIFY_LOADED = false;
let OUTGOING_WEBHOOKS = [];
let OUTGOING_WEBHOOKS_LOADED = false;
let LAST_REVEALED_SECRET = null;        // shown once after a POST; cleared on next paint
let SUPPRESSED_CUSTOMERS = [];
let SUPPRESSED_LOADED = false;
let WORKSPACE_SETTINGS = null;
let WORKSPACE_SETTINGS_LOADED = false;
let ME_PREFS = null;
let ME_PREFS_LOADED = false;
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
    </div>

    ${settingsWorkspaceBranding()}`;
}

function settingsWorkspaceBranding() {
  // Reuses the same workspace settings state lazy-loaded by the AI
  // Assistant tab (PR #222). Either tab triggers the fetch; whichever
  // lands first wins, the other paints from cache.
  if (!WORKSPACE_SETTINGS_LOADED) {
    WORKSPACE_SETTINGS_LOADED = true;
    apiGet('/api/v1/workspace/settings')
      .then((res) => { WORKSPACE_SETTINGS = res.workspace; window.renderPage('settings'); })
      .catch((err) => { console.warn('[settings] workspace load failed:', err); });
  }
  const ws = WORKSPACE_SETTINGS;
  const isAdmin = window.isAdmin();
  const logoUrl = ws?.logo_url || '';
  const color   = ws?.primary_color || '';
  const preview = logoUrl
    ? `<img src="${window.escAttr(logoUrl)}" alt="" style="max-height:32px;max-width:160px;vertical-align:middle;border:1px solid var(--rule);border-radius:4px;padding:2px;background:#fff" onerror="this.style.display='none'"/>`
    : '<span style="color:var(--ink3);font-size:11px;font-family:\'DM Mono\',monospace">No logo configured</span>';
  return `
    <div class="settings-section">
      <div class="settings-h">Workspace branding</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        Logo + primary color are shown on the sidebar, in CSAT survey + magic-link emails, and on the customer portal. Host the logo image somewhere public (your CDN, an S3 bucket, etc.) and paste the URL here. Admins only.
      </div>
      <div class="settings-row" style="border:none;padding-bottom:8px">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Current</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">Shown wherever the workspace surfaces to a customer or agent.</div>
        </div>
        <div>${preview}</div>
      </div>
      <div class="form-row">
        <label class="form-label">Upload logo</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="file" id="brand-logo-file" accept="image/png,image/jpeg,image/svg+xml,image/webp" ${isAdmin ? '' : 'disabled'} style="flex:1;font-size:12px"/>
          <button class="btn btn-sm" onclick="uploadWorkspaceLogo()" ${isAdmin ? '' : 'disabled'}>Upload</button>
        </div>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">PNG, JPG, SVG, or WEBP up to 2 MB. Uploaded files are hosted on the workspace's own brand-assets bucket.</div>
      </div>
      <div class="form-row">
        <label class="form-label">Or paste a URL</label>
        <input class="form-input" id="brand-logo-url" type="url" value="${window.escAttr(logoUrl)}" placeholder="https://cdn.example.com/your-logo.png" ${isAdmin ? '' : 'disabled'}/>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Externally hosted images work too. Leave empty (and don't upload) to fall back to the workspace name.</div>
      </div>
      <div class="form-row">
        <label class="form-label">Primary color</label>
        <div style="display:flex;align-items:center;gap:10px">
          <input class="form-input" id="brand-primary-color" type="text" value="${window.escAttr(color)}" placeholder="#8b5cf6" style="font-family:'DM Mono',monospace;max-width:140px" ${isAdmin ? '' : 'disabled'}/>
          <input type="color" id="brand-primary-color-picker" value="${color || '#8b5cf6'}" oninput="document.getElementById('brand-primary-color').value=this.value" ${isAdmin ? '' : 'disabled'} style="width:34px;height:34px;border:1px solid var(--rule);border-radius:4px;padding:0;cursor:pointer;background:none"/>
        </div>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Hex like <code style="font-family:'DM Mono',monospace">#8b5cf6</code>. Used for chips, focus rings, and the AI-draft button. Empty falls back to the default purple.</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-solid btn-sm" onclick="saveWorkspaceBranding()" ${isAdmin ? '' : 'disabled'}>Save</button>
        <span id="brand-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;align-self:center"></span>
      </div>
    </div>

    ${settingsPortalCopy(ws, isAdmin)}`;
}

function settingsPortalCopy(ws, isAdmin) {
  const tagline = ws?.portal_tagline || '';
  const intro   = ws?.portal_intro   || '';
  const footer  = ws?.portal_footer  || '';
  return `
    <div class="settings-section">
      <div class="settings-h">Customer portal copy</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        Custom text shown on the customer-facing portal (the page at <code style="font-family:'DM Mono',monospace">portal.html?ws=${window.escHtml(ws?.slug || 'your-workspace')}</code>). Leave any field empty to fall back to the platform default. Admins only.
      </div>
      <div class="form-row">
        <label class="form-label">Tagline <span style="color:var(--ink3);font-weight:400;font-family:'DM Mono',monospace;font-size:11px">— shown under the workspace name in the portal header</span></label>
        <input class="form-input" id="brand-portal-tagline" type="text" maxlength="100" value="${window.escAttr(tagline)}" placeholder="Help &amp; support" ${isAdmin ? '' : 'disabled'}/>
      </div>
      <div class="form-row">
        <label class="form-label">Intro paragraph <span style="color:var(--ink3);font-weight:400;font-family:'DM Mono',monospace;font-size:11px">— shown above the help / submit-request cards</span></label>
        <textarea class="form-input" id="brand-portal-intro" maxlength="1000" rows="3" placeholder="Welcome! Search our help center below, or submit a ticket and our team will get back to you." ${isAdmin ? '' : 'disabled'} style="resize:vertical;font-family:inherit">${window.escHtml(intro)}</textarea>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Up to 1000 characters. Plain text — no markdown or HTML.</div>
      </div>
      <div class="form-row">
        <label class="form-label">Footer <span style="color:var(--ink3);font-weight:400;font-family:'DM Mono',monospace;font-size:11px">— replaces "Powered by Maestro Desk"</span></label>
        <input class="form-input" id="brand-portal-footer" type="text" maxlength="500" value="${window.escAttr(footer)}" placeholder="© Your Company 2026 · Need urgent help? Call +1 555 0100" ${isAdmin ? '' : 'disabled'}/>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-solid btn-sm" onclick="savePortalCopy()" ${isAdmin ? '' : 'disabled'}>Save portal copy</button>
        <span id="portal-copy-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;align-self:center"></span>
      </div>
    </div>`;
}

export async function savePortalCopy() {
  if (!window.isAdmin()) return;
  const tagline = document.getElementById('brand-portal-tagline').value.trim();
  const intro   = document.getElementById('brand-portal-intro').value.trim();
  const footer  = document.getElementById('brand-portal-footer').value.trim();
  const msg = document.getElementById('portal-copy-msg');
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPatch('/api/v1/workspace/settings', {
      portal_tagline: tagline || null,
      portal_intro:   intro   || null,
      portal_footer:  footer  || null,
    });
    WORKSPACE_SETTINGS = res.workspace;
    msg.textContent = '✓ Saved';
    msg.style.color = 'var(--green)';
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

export async function uploadWorkspaceLogo() {
  if (!window.isAdmin()) return;
  const fileEl = document.getElementById('brand-logo-file');
  const file = fileEl?.files?.[0];
  const msg = document.getElementById('brand-msg');
  if (!file) {
    msg.textContent = 'Pick a file first';
    msg.style.color = 'var(--red)';
    return;
  }
  msg.textContent = 'Uploading...';
  msg.style.color = 'var(--ink3)';
  try {
    const form = new FormData();
    form.append('file', file);
    // apiPost serializes JSON; bypass it for multipart by calling fetch
    // directly. The api-client's auth + workspace headers live in
    // window for the standard JSON paths — we replicate the headers
    // here without the Content-Type (the browser sets the multipart
    // boundary on its own).
    const jwt         = sessionStorage.getItem('maestro_jwt') || '';
    const workspaceId = sessionStorage.getItem('maestro_workspace_id') || '';
    const res = await fetch(`${API_BASE}/api/v1/workspace/branding/logo`, {
      method: 'POST',
      headers: {
        Authorization:   `Bearer ${jwt}`,
        'X-Workspace-Id': workspaceId,
      },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    // Push the new URL into the local state + the URL input + apply
    // the brand so the sidebar updates without re-signing-in.
    WORKSPACE_SETTINGS = { ...(WORKSPACE_SETTINGS || {}), logo_url: data.logo_url };
    const urlEl = document.getElementById('brand-logo-url');
    if (urlEl) urlEl.value = data.logo_url;
    window.applyWorkspaceBrand?.({
      name:         WORKSPACE_SETTINGS.name,
      slug:         WORKSPACE_SETTINGS.slug,
      logoUrl:      data.logo_url,
      primaryColor: WORKSPACE_SETTINGS.primary_color,
    });
    msg.textContent = '✓ Uploaded';
    msg.style.color = 'var(--green)';
    fileEl.value = '';
    window.renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Upload failed';
    msg.style.color = 'var(--red)';
  }
}

export async function saveWorkspaceBranding() {
  if (!window.isAdmin()) return;
  const logoUrl = document.getElementById('brand-logo-url').value.trim();
  const color   = document.getElementById('brand-primary-color').value.trim();
  const msg = document.getElementById('brand-msg');
  if (logoUrl && !/^https?:\/\//i.test(logoUrl)) {
    msg.textContent = 'Logo URL must start with https://';
    msg.style.color = 'var(--red)';
    return;
  }
  if (color && !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)) {
    msg.textContent = 'Color must be a hex like #8b5cf6';
    msg.style.color = 'var(--red)';
    return;
  }
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPatch('/api/v1/workspace/settings', {
      logo_url:      logoUrl || null,
      primary_color: color   || null,
    });
    WORKSPACE_SETTINGS = res.workspace;
    msg.textContent = '✓ Saved';
    msg.style.color = 'var(--green)';
    // Apply the new brand to the sidebar + tab title immediately so
    // the user sees their change reflected without re-signing-in.
    window.applyWorkspaceBrand?.({
      name:         res.workspace.name,
      slug:         res.workspace.slug,
      logoUrl:      res.workspace.logo_url,
      primaryColor: res.workspace.primary_color,
    });
    // Re-render the settings page so the preview row picks up the
    // new logo / color too.
    window.renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
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
  // Email preferences live server-side (per-user, on public.users).
  // Lazy-load on tab open + re-render once the fetch lands so the
  // toggle reflects the persisted value.
  if (!ME_PREFS_LOADED) {
    ME_PREFS_LOADED = true;
    apiGet('/api/v1/me')
      .then((res) => { ME_PREFS = res.user; window.renderPage('settings'); })
      .catch((err) => { console.warn('[settings] me load failed:', err); });
  }
  const mentionEmailOn = ME_PREFS ? ME_PREFS.mention_email_enabled !== false : true;
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
    </div>

    <div class="settings-section">
      <div class="settings-h">Email notifications</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Choose when we email you outside the app. Saved to your account, applies across devices.</div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">@mention emails</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">A teammate @-mentions you in an internal note.</div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${mentionEmailOn ? 'checked' : ''} onchange="setMentionEmailPref(this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div id="mention-email-msg" style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;margin-top:8px;min-height:14px"></div>
    </div>`;
}

export async function setMentionEmailPref(enabled) {
  const msg = document.getElementById('mention-email-msg');
  if (msg) { msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)'; }
  try {
    const res = await apiPatch('/api/v1/me', { mention_email_enabled: enabled });
    ME_PREFS = res.user;
    if (msg) { msg.textContent = enabled ? '✓ Enabled' : '✓ Disabled'; msg.style.color = 'var(--green)'; }
  } catch (err) {
    if (msg) { msg.textContent = err?.message || 'Save failed'; msg.style.color = 'var(--red)'; }
    // Revert UI if the patch failed.
    ME_PREFS_LOADED = false;
    window.renderPage('settings');
  }
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
  // Workspace-level settings live server-side, loaded lazily on first
  // paint of this tab. Re-render once the fetch resolves so the toggle
  // reflects the current value.
  if (!WORKSPACE_SETTINGS_LOADED) {
    WORKSPACE_SETTINGS_LOADED = true;
    apiGet('/api/v1/workspace/settings')
      .then((res) => { WORKSPACE_SETTINGS = res.workspace; window.renderPage('settings'); })
      .catch((err) => { console.warn('[settings] workspace load failed:', err); });
  }
  const ws = WORKSPACE_SETTINGS;
  const autoBumpOn = ws ? ws.auto_priority_bump_on_angry !== false : true;
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
    </div>

    <div class="settings-section">
      <div class="settings-h">Sentiment automation</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        When a customer message is classified as angry, automatically bump the ticket's priority to <strong style="color:var(--ink2)">high</strong> (only if it's currently lower). A system message is added to the ticket explaining the change. Turning this off keeps sentiment scoring + badges + filters intact, but priority stays under explicit human control.
      </div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Auto-bump priority on angry sentiment</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">Workspace-wide. Admins only.</div>
        </div>
        <label class="toggle"><input type="checkbox" ${autoBumpOn ? 'checked' : ''} onchange="setAutoPriorityBump(this.checked)" ${window.isAdmin() ? '' : 'disabled'}/><span class="toggle-slider"></span></label>
      </div>
      <div id="auto-bump-msg" style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;margin-top:8px;min-height:14px"></div>
    </div>

    ${settingsCsatCadence(ws)}`;
}

function settingsCsatCadence(ws) {
  const cadence = Array.isArray(ws?.csat_reminder_days) ? ws.csat_reminder_days : [3, 7, 14];
  const cadenceStr = cadence.length === 0 ? '(none — reminders off)' : cadence.join(', ');
  const isAdmin = window.isAdmin();
  return `
    <div class="settings-section">
      <div class="settings-h">CSAT reminder cadence</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        Days after the initial CSAT request to send reminders. Cumulative — each value is days since the original request, not days since the previous reminder. Cap of 6 entries; each value 1–365 days, strictly ascending. Leave empty (just spaces / comma) to disable reminders entirely.
      </div>
      <div class="form-row">
        <label class="form-label">Schedule (comma-separated days)</label>
        <input class="form-input" id="csat-cadence-input" value="${window.escAttr(cadenceStr === '(none — reminders off)' ? '' : cadenceStr)}" placeholder="3, 7, 14" ${isAdmin ? '' : 'disabled'} style="font-family:'DM Mono',monospace"/>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Currently: <span style="font-family:'DM Mono',monospace;color:var(--ink2)">${window.escHtml(cadenceStr)}</span></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-solid btn-sm" onclick="saveCsatCadence()" ${isAdmin ? '' : 'disabled'}>Save cadence</button>
        <span id="csat-cadence-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;align-self:center"></span>
      </div>
    </div>`;
}

export async function saveCsatCadence() {
  if (!window.isAdmin()) return;
  const raw = (document.getElementById('csat-cadence-input').value || '').trim();
  const msg = document.getElementById('csat-cadence-msg');
  // Parse: comma-separated ints; empty string → empty array (reminders off).
  const parsed = raw === ''
    ? []
    : raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => Number(s));
  if (parsed.some((n) => !Number.isInteger(n) || n < 1 || n > 365)) {
    msg.textContent = 'Each day must be an integer 1–365';
    msg.style.color = 'var(--red)';
    return;
  }
  if (parsed.length > 6) {
    msg.textContent = 'At most 6 reminders';
    msg.style.color = 'var(--red)';
    return;
  }
  if (parsed.some((v, i) => i > 0 && v <= parsed[i - 1])) {
    msg.textContent = 'Days must be strictly ascending';
    msg.style.color = 'var(--red)';
    return;
  }
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPatch('/api/v1/workspace/settings', { csat_reminder_days: parsed });
    WORKSPACE_SETTINGS = res.workspace;
    msg.textContent = '✓ Saved';
    msg.style.color = 'var(--green)';
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

export async function setAutoPriorityBump(enabled) {
  if (!window.isAdmin()) return;
  const msg = document.getElementById('auto-bump-msg');
  if (msg) { msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)'; }
  try {
    const res = await apiPatch('/api/v1/workspace/settings', { auto_priority_bump_on_angry: enabled });
    WORKSPACE_SETTINGS = res.workspace;
    if (msg) { msg.textContent = enabled ? '✓ Enabled' : '✓ Disabled'; msg.style.color = 'var(--green)'; }
  } catch (err) {
    if (msg) { msg.textContent = err?.message || 'Save failed'; msg.style.color = 'var(--red)'; }
    // Revert the visual state if the patch failed.
    WORKSPACE_SETTINGS_LOADED = false;
    window.renderPage('settings');
  }
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

      <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule)">
        <div style="font-size:12px;font-weight:600;color:var(--ink);margin-bottom:6px">Two-way sync (optional)</div>
        <div style="font-size:11px;color:var(--ink3);margin-bottom:12px;line-height:1.5">
          Lets agents reply directly from the Slack thread that the notification creates — replies are recorded on the ticket. Requires a Slack app with the <code style="font-family:'DM Mono',monospace;color:var(--ink2)">chat:write</code>, <code style="font-family:'DM Mono',monospace;color:var(--ink2)">users:read</code>, and <code style="font-family:'DM Mono',monospace;color:var(--ink2)">users:read.email</code> scopes plus the Events API URL pointed at <code style="font-family:'DM Mono',monospace;color:var(--ink2)">/api/v1/webhooks/slack/events</code>.
        </div>
        ${slack?.has_bot_token ? `
          <div style="margin-bottom:10px;padding:8px 10px;background:var(--green-lt);border:1px solid var(--green);border-radius:var(--r);font-size:11px;color:var(--green);display:flex;gap:8px;align-items:center">
            <span style="font-weight:600">Two-way ready</span>
            <span style="font-family:'DM Mono',monospace;color:var(--ink2)">xoxb-...${window.escHtml(slack.bot_token_suffix || '')}</span>
          </div>` : ''}
        <div class="form-row">
          <label class="form-label">Bot token</label>
          <input class="form-input" id="slack-bot-token" type="password" placeholder="${slack?.has_bot_token ? 'Paste a new token to rotate' : 'xoxb-...'}" autocomplete="off"/>
        </div>
        <div class="form-row">
          <label class="form-label">Signing secret</label>
          <input class="form-input" id="slack-signing-secret" type="password" placeholder="${slack?.has_signing_secret ? 'Paste a new secret to rotate' : 'app signing secret'}" autocomplete="off"/>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-solid btn-sm" onclick="saveSlackIntegration()">Save</button>
        ${slack ? '<button class="btn btn-sm btn-danger" onclick="deleteSlackIntegration()">Disconnect</button>' : ''}
        <span id="slack-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace"></span>
      </div>
    </div>
    ${settingsStripeSection()}
    ${settingsShopifySection()}
    ${settingsOutgoingWebhooksSection()}
    ${settingsSuppressionListSection()}`;
}

function settingsStripeSection() {
  if (!STRIPE_LOADED) {
    STRIPE_LOADED = true;
    apiGet('/api/v1/integrations/stripe')
      .then((res) => { STRIPE_INTEGRATION = res.integration; window.renderPage('settings'); })
      .catch((err) => { console.warn('[settings] stripe load failed:', err); });
  }
  const stripe = STRIPE_INTEGRATION;
  const connected = Boolean(stripe?.has_key);
  return `
    <div class="settings-section">
      <div class="settings-h">Stripe</div>
      <div class="settings-desc" style="margin-bottom:14px">
        Surface a customer's Stripe subscription + recent charge history on the ticket sidebar.
        Paste a <a href="https://dashboard.stripe.com/apikeys" target="_blank" style="color:var(--purple)">restricted Stripe API key</a> with read-only access on customers, subscriptions, and charges.
      </div>
      ${connected ? `
        <div style="margin-bottom:14px;padding:10px 12px;background:var(--green-lt);border:1px solid var(--green);border-radius:var(--r);font-size:12px;color:var(--green);display:flex;gap:10px;align-items:center">
          <span style="font-weight:600">Connected</span>
          <span style="font-family:'DM Mono',monospace;color:var(--ink2)">${stripe.mode === 'test' ? 'TEST' : 'LIVE'} mode · ...${window.escHtml(stripe.key_suffix || '')}</span>
        </div>` : ''}
      <div class="form-row">
        <label class="form-label">${connected ? 'Replace API key' : 'API key'}</label>
        <input class="form-input" id="stripe-key" type="password" placeholder="${connected ? 'Paste a new key to rotate' : 'rk_test_... or rk_live_...'}" autocomplete="off"/>
      </div>
      <div class="form-row" style="display:flex;align-items:center;gap:8px">
        <label class="toggle"><input type="checkbox" id="stripe-active" ${stripe?.active !== false ? 'checked' : ''}/><span class="toggle-slider"></span></label>
        <span style="font-size:13px;color:var(--ink2)">Active</span>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-solid btn-sm" onclick="saveStripeIntegration()">${connected ? 'Update' : 'Connect'}</button>
        ${connected ? '<button class="btn btn-sm btn-danger" onclick="deleteStripeIntegration()">Disconnect</button>' : ''}
        <span id="stripe-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace"></span>
      </div>
    </div>`;
}

export async function saveStripeIntegration() {
  if (!window.isAdmin()) return;
  const key    = document.getElementById('stripe-key').value.trim();
  const active = document.getElementById('stripe-active').checked;
  const msg = document.getElementById('stripe-msg');
  // When the field is empty + a key is already on file, the user is
  // just toggling active. Patch with just the active flag in that case.
  if (!key && !STRIPE_INTEGRATION?.has_key) {
    msg.textContent = 'API key is required'; msg.style.color = 'var(--red)'; return;
  }
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    const body = key ? { api_key: key, active } : { api_key: rebuildKeyForToggle(), active };
    if (!body.api_key) {
      msg.textContent = 'Re-paste the key to update settings'; msg.style.color = 'var(--red)'; return;
    }
    await apiPut('/api/v1/integrations/stripe', body);
    // Refresh the GET to get the masked summary back.
    const res = await apiGet('/api/v1/integrations/stripe');
    STRIPE_INTEGRATION = res.integration;
    document.getElementById('stripe-key').value = '';
    msg.textContent = 'Saved'; msg.style.color = 'var(--green)';
    window.renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

// Stub used when the user toggles active without re-entering the key.
// We don't have the key client-side (the server masks it), so the only
// safe path is to require a re-paste for any update. Returning null
// triggers that branch above.
function rebuildKeyForToggle() { return null; }

export async function deleteStripeIntegration() {
  if (!window.isAdmin()) return;
  if (!confirm('Disconnect Stripe? Ticket sidebars will stop showing subscription + charge context.')) return;
  try {
    await apiDelete('/api/v1/integrations/stripe');
    STRIPE_INTEGRATION = null;
    window.renderPage('settings');
  } catch (err) {
    alert(`Couldn't disconnect: ${err?.message || err}`);
  }
}

function settingsShopifySection() {
  if (!SHOPIFY_LOADED) {
    SHOPIFY_LOADED = true;
    apiGet('/api/v1/integrations/shopify')
      .then((res) => { SHOPIFY_INTEGRATION = res.integration; window.renderPage('settings'); })
      .catch((err) => { console.warn('[settings] shopify load failed:', err); });
  }
  const shopify = SHOPIFY_INTEGRATION;
  const connected = Boolean(shopify?.has_token);
  return `
    <div class="settings-section">
      <div class="settings-h">Shopify</div>
      <div class="settings-desc" style="margin-bottom:14px">
        Surface a customer's Shopify order history on the customer sidebar.
        Create a <a href="https://help.shopify.com/manual/apps/app-types/custom-apps" target="_blank" style="color:var(--purple)">custom app</a> in your store admin with read access on customers + orders, then paste the Admin API access token below.
      </div>
      ${connected ? `
        <div style="margin-bottom:14px;padding:10px 12px;background:var(--green-lt);border:1px solid var(--green);border-radius:var(--r);font-size:12px;color:var(--green);display:flex;gap:10px;align-items:center">
          <span style="font-weight:600">Connected</span>
          <span style="font-family:'DM Mono',monospace;color:var(--ink2)">${window.escHtml(shopify.shop || '')}.myshopify.com · ...${window.escHtml(shopify.token_suffix || '')}</span>
        </div>` : ''}
      <div class="form-row">
        <label class="form-label">Shop subdomain</label>
        <div style="display:flex;align-items:center;gap:0">
          <input class="form-input" id="shopify-shop" type="text" placeholder="acme-store" autocomplete="off" value="${connected ? window.escAttr(shopify.shop || '') : ''}" style="border-top-right-radius:0;border-bottom-right-radius:0"/>
          <span style="padding:8px 12px;background:var(--off2);border:1px solid var(--rule);border-left:none;border-radius:0 var(--r) var(--r) 0;font-family:'DM Mono',monospace;font-size:12px;color:var(--ink3)">.myshopify.com</span>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">${connected ? 'Replace access token' : 'Admin API access token'}</label>
        <input class="form-input" id="shopify-token" type="password" placeholder="${connected ? 'Paste a new token to rotate' : 'shpat_...'}" autocomplete="off"/>
      </div>
      <div class="form-row" style="display:flex;align-items:center;gap:8px">
        <label class="toggle"><input type="checkbox" id="shopify-active" ${shopify?.active !== false ? 'checked' : ''}/><span class="toggle-slider"></span></label>
        <span style="font-size:13px;color:var(--ink2)">Active</span>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-solid btn-sm" onclick="saveShopifyIntegration()">${connected ? 'Update' : 'Connect'}</button>
        ${connected ? '<button class="btn btn-sm btn-danger" onclick="deleteShopifyIntegration()">Disconnect</button>' : ''}
        <span id="shopify-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace"></span>
      </div>
    </div>`;
}

export async function saveShopifyIntegration() {
  if (!window.isAdmin()) return;
  const shop   = document.getElementById('shopify-shop').value.trim();
  const token  = document.getElementById('shopify-token').value.trim();
  const active = document.getElementById('shopify-active').checked;
  const msg = document.getElementById('shopify-msg');
  if (!shop) {
    msg.textContent = 'Shop subdomain required'; msg.style.color = 'var(--red)'; return;
  }
  if (!token && !SHOPIFY_INTEGRATION?.has_token) {
    msg.textContent = 'Access token required'; msg.style.color = 'var(--red)'; return;
  }
  if (!token && SHOPIFY_INTEGRATION?.has_token) {
    // Toggle-only update path is the same as Stripe: server masks the
    // token so we can't reconstruct it. Force a re-paste.
    msg.textContent = 'Re-paste the token to update settings'; msg.style.color = 'var(--red)'; return;
  }
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    await apiPut('/api/v1/integrations/shopify', { shop, access_token: token, active });
    const res = await apiGet('/api/v1/integrations/shopify');
    SHOPIFY_INTEGRATION = res.integration;
    document.getElementById('shopify-token').value = '';
    msg.textContent = 'Saved'; msg.style.color = 'var(--green)';
    window.renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

export async function deleteShopifyIntegration() {
  if (!window.isAdmin()) return;
  if (!confirm('Disconnect Shopify? Customer sidebars will stop showing order history.')) return;
  try {
    await apiDelete('/api/v1/integrations/shopify');
    SHOPIFY_INTEGRATION = null;
    window.renderPage('settings');
  } catch (err) {
    alert(`Couldn't disconnect: ${err?.message || err}`);
  }
}

// ─── Outgoing webhooks ──────────────────────────────────────────────────
//
// Multiple webhooks per workspace, distinct from Slack/Stripe/Shopify
// (which are single-instance). List + Create + Delete are exposed in
// this slice; rotating the secret = delete + recreate. Secrets are
// surfaced once at creation time via LAST_REVEALED_SECRET, then
// cleared on the next render so they can't be re-read by paging
// through DevTools.

function settingsOutgoingWebhooksSection() {
  if (!OUTGOING_WEBHOOKS_LOADED) {
    OUTGOING_WEBHOOKS_LOADED = true;
    apiGet('/api/v1/integrations/webhooks')
      .then((res) => { OUTGOING_WEBHOOKS = res.webhooks || []; window.renderPage('settings'); })
      .catch((err) => { console.warn('[settings] webhooks load failed:', err); });
  }
  const list = OUTGOING_WEBHOOKS;

  // One-time secret reveal — pulled out before render so the next
  // settings re-render starts clean and the user can't accidentally
  // re-read it by switching tabs.
  const revealedBanner = LAST_REVEALED_SECRET ? `
    <div style="margin-bottom:14px;padding:12px 14px;background:var(--amber-lt);border:1px solid var(--amber);border-radius:var(--r);font-size:12px">
      <div style="font-weight:600;color:var(--amber);margin-bottom:6px">Save this signing secret — it won't be shown again</div>
      <div style="font-family:'DM Mono',monospace;color:var(--ink);background:var(--off2);padding:8px 10px;border-radius:3px;word-break:break-all;user-select:all">${window.escHtml(LAST_REVEALED_SECRET)}</div>
      <div style="margin-top:6px;color:var(--ink3)">Use this with HMAC-SHA256 over <code>v0:&lt;X-Maestro-Timestamp&gt;:&lt;raw-body&gt;</code> and compare to the <code>X-Maestro-Signature</code> header.</div>
    </div>` : '';
  LAST_REVEALED_SECRET = null;

  const rows = list.length === 0 ? `
    <div style="color:var(--ink3);font-size:12px;padding:14px 0;text-align:center">No outgoing webhooks configured.</div>
  ` : list.map((w) => {
    const last = w.last_delivery_at ? new Date(w.last_delivery_at).toISOString().slice(0, 19).replace('T', ' ') : '—';
    const statusColor = w.last_delivery_error
      ? 'var(--red)'
      : (w.last_delivery_status && w.last_delivery_status < 400 ? 'var(--green)' : 'var(--ink3)');
    const statusLabel = w.last_delivery_error
      ? `error · ${window.escHtml(w.last_delivery_error.slice(0, 40))}`
      : (w.last_delivery_status ? `HTTP ${w.last_delivery_status}` : 'no deliveries yet');
    return `
      <div style="padding:10px 0;border-bottom:1px solid var(--rule);display:flex;align-items:center;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;color:var(--ink);font-size:13px">${window.escHtml(w.name)}</div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(w.url)}</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">
            <span style="color:${statusColor}">${statusLabel}</span>
            <span style="color:var(--ink4);margin-left:8px">last: ${last}</span>
            <span style="color:var(--ink4);margin-left:8px">${w.events.length} event${w.events.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        <button class="btn btn-sm" onclick="editOutgoingWebhook('${window.escAttr(w.id)}')">Edit</button>
        <button class="btn btn-sm" onclick="showOutgoingWebhookDeliveries('${window.escAttr(w.id)}', '${window.escAttr(w.name)}')">Deliveries</button>
        <button class="btn btn-sm btn-danger" onclick="deleteOutgoingWebhook('${window.escAttr(w.id)}')">Delete</button>
      </div>`;
  }).join('');

  const eventCheckboxes = SLACK_EVENTS.map((e) => `
    <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">
      <input type="checkbox" id="wh-evt-${e.k}" checked/>
      ${window.escHtml(e.l)}
    </label>`).join('');

  return `
    <div class="settings-section">
      <div class="settings-h">Outgoing webhooks</div>
      <div class="settings-desc" style="margin-bottom:14px">
        Register HTTP endpoints to receive ticket-event POSTs. Generic alternative to the Slack integration — useful for piping events into a CRM, analytics pipeline, or homemade automation. Payloads are JSON, signed with HMAC-SHA256 using a secret generated at creation time.
      </div>
      ${revealedBanner}
      <div>${rows}</div>
      <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule)">
        <div style="font-size:12px;font-weight:600;color:var(--ink);margin-bottom:10px">Add webhook</div>
        <div class="form-row">
          <label class="form-label">Name</label>
          <input class="form-input" id="wh-name" placeholder="e.g. CRM sync"/>
        </div>
        <div class="form-row">
          <label class="form-label">URL</label>
          <input class="form-input" id="wh-url" type="url" placeholder="https://your-receiver.example.com/maestro"/>
        </div>
        <div class="form-row">
          <label class="form-label">Events</label>
          ${eventCheckboxes}
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-solid btn-sm" onclick="createOutgoingWebhook()">Create</button>
          <span id="wh-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace"></span>
        </div>
      </div>
    </div>`;
}

export async function createOutgoingWebhook() {
  if (!window.isAdmin()) return;
  const name   = document.getElementById('wh-name').value.trim();
  const url    = document.getElementById('wh-url').value.trim();
  const events = SLACK_EVENTS.filter((e) => document.getElementById(`wh-evt-${e.k}`)?.checked).map((e) => e.k);
  const msg = document.getElementById('wh-msg');
  if (!name) { msg.textContent = 'Name is required'; msg.style.color = 'var(--red)'; return; }
  if (!url)  { msg.textContent = 'URL is required';  msg.style.color = 'var(--red)'; return; }
  if (events.length === 0) { msg.textContent = 'Pick at least one event'; msg.style.color = 'var(--red)'; return; }
  msg.textContent = 'Creating...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPost('/api/v1/integrations/webhooks', { name, url, events });
    LAST_REVEALED_SECRET = res.secret;
    // Re-fetch the list so the new row appears.
    const list = await apiGet('/api/v1/integrations/webhooks');
    OUTGOING_WEBHOOKS = list.webhooks || [];
    window.renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Create failed';
    msg.style.color = 'var(--red)';
  }
}

export async function deleteOutgoingWebhook(id) {
  if (!window.isAdmin()) return;
  if (!confirm('Delete this webhook? Events will stop firing immediately.')) return;
  try {
    await apiDelete(`/api/v1/integrations/webhooks/${encodeURIComponent(id)}`);
    OUTGOING_WEBHOOKS = OUTGOING_WEBHOOKS.filter((w) => w.id !== id);
    window.renderPage('settings');
  } catch (err) {
    alert(`Couldn't delete: ${err?.message || err}`);
  }
}

// ─── Postmark suppression list ──────────────────────────────────────────
//
// Surfaces every customer whose email is currently in hard or spam
// bounce state. Reset clears the local bounce summary; if the address
// is still suppressed at Postmark, the next send will bounce again
// and re-populate this list. Soft bounces aren't shown here — they're
// transient by nature and the count badge on the customer detail is
// enough.

function settingsSuppressionListSection() {
  if (!SUPPRESSED_LOADED) {
    SUPPRESSED_LOADED = true;
    apiGet('/api/v1/integrations/postmark/suppressed')
      .then((res) => { SUPPRESSED_CUSTOMERS = res.suppressed || []; window.renderPage('settings'); })
      .catch((err) => { console.warn('[settings] suppression load failed:', err); });
  }
  const list = SUPPRESSED_CUSTOMERS;
  const fmtTs = (ts) => ts ? new Date(ts).toISOString().slice(0, 10) : '—';
  const rows = list.length === 0 ? `
    <div style="color:var(--ink3);font-size:12px;padding:14px 0;text-align:center">No suppressed addresses.</div>
  ` : list.map((c) => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.display_id || '(no name)';
    const stateColor = c.email_bounce_state === 'spam' ? 'var(--red)' : 'var(--red)';
    return `
      <div style="padding:10px 0;border-bottom:1px solid var(--rule);display:flex;align-items:center;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;color:var(--ink);font-size:13px">${window.escHtml(name)}</div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(c.email || '')}</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">
            <span style="color:${stateColor};font-weight:600;text-transform:uppercase;font-family:'DM Mono',monospace">${window.escHtml(c.email_bounce_state)}</span>
            <span style="color:var(--ink4);margin-left:8px">${window.escHtml(c.email_last_bounce_type || '')}</span>
            <span style="color:var(--ink4);margin-left:8px">last: ${fmtTs(c.email_last_bounce_at)}</span>
            <span style="color:var(--ink4);margin-left:8px">${c.email_bounce_count} bounce${c.email_bounce_count === 1 ? '' : 's'}</span>
          </div>
        </div>
        <button class="btn btn-sm" onclick="resetSuppressedCustomer('${window.escAttr(c.id)}')">Reset</button>
      </div>`;
  }).join('');

  return `
    <div class="settings-section">
      <div class="settings-h">Postmark suppression list</div>
      <div class="settings-desc" style="margin-bottom:14px">
        Customers whose email is currently flagged as undeliverable based on Postmark Bounce / SpamComplaint webhook events. Resetting clears the local state — if the address is still suppressed at Postmark, the next send will bounce and re-populate it.
      </div>
      <div>${rows}</div>
    </div>`;
}

export async function resetSuppressedCustomer(customerId) {
  if (!window.isAdmin()) return;
  if (!confirm('Reset this customer\'s bounce state? Sends will resume immediately.')) return;
  try {
    await apiPost(`/api/v1/integrations/postmark/suppressed/${encodeURIComponent(customerId)}/reset`);
    SUPPRESSED_CUSTOMERS = SUPPRESSED_CUSTOMERS.filter((c) => c.id !== customerId);
    // Also clear the in-memory customer record so the badge disappears
    // on the customer detail without a full bootstrap reload.
    if (typeof CUSTOMERS !== 'undefined') {
      const cust = CUSTOMERS.find((c) => c._uuid === customerId);
      if (cust) {
        cust.emailBounceState = 'none';
        cust.emailBounceCount = 0;
        cust.emailLastBounce  = null;
      }
    }
    window.renderPage('settings');
  } catch (err) {
    alert(`Couldn't reset: ${err?.message || err}`);
  }
}

// ─── Delivery log modal ─────────────────────────────────────────────────
//
// Opens a modal listing the 50 most recent delivery attempts for one
// webhook. Renders empty-then-load (showModal first with a "loading"
// stub, then swap the inner container's HTML when the fetch resolves)
// so the user gets immediate feedback. No re-fetch or live update —
// this is a snapshot view, the user closes + reopens for a refresh.

export function showOutgoingWebhookDeliveries(id, name) {
  showModal(
    `Deliveries · ${window.escHtml(name)}`,
    `<div id="wh-deliveries-body" data-webhook-id="${window.escAttr(id)}" style="min-height:120px;color:var(--ink3);font-size:12px">Loading…</div>`,
    null, null, true,
  );
  loadOutgoingWebhookDeliveries(id);
}

async function loadOutgoingWebhookDeliveries(id) {
  const container = document.getElementById('wh-deliveries-body');
  if (!container) return;
  try {
    const res = await apiGet(`/api/v1/integrations/webhooks/${encodeURIComponent(id)}/deliveries`);
    container.innerHTML = renderDeliveryRows(id, res.deliveries || []);
  } catch (err) {
    container.innerHTML = `<div style="color:var(--red);font-size:12px">${window.escHtml(err?.message || 'Failed to load')}</div>`;
  }
}

function renderDeliveryRows(webhookId, deliveries) {
  if (deliveries.length === 0) {
    return `<div style="color:var(--ink3);font-size:12px;text-align:center;padding:20px 0">No deliveries yet.</div>`;
  }
  const stateColor = (s) => s === 'success' ? 'var(--green)' : s === 'exhausted' ? 'var(--red)' : 'var(--amber)';
  const fmtTs = (ts) => ts ? new Date(ts).toISOString().slice(0, 19).replace('T', ' ') : '—';
  return `
    <div style="display:grid;grid-template-columns:auto 1fr auto auto auto auto auto;gap:8px 12px;font-size:11px;align-items:baseline">
      <div style="color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">State</div>
      <div style="color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Event</div>
      <div style="color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Attempts</div>
      <div style="color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Last status</div>
      <div style="color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Last attempt</div>
      <div style="color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Next attempt</div>
      <div></div>
      ${deliveries.map((d) => {
        const last = d.last_status
          ? `HTTP ${d.last_status}`
          : (d.last_error ? `<span title="${window.escAttr(d.last_error)}">err</span>` : '—');
        const retryBtn = d.state === 'exhausted'
          ? `<button class="btn btn-sm" onclick="retryWebhookDelivery('${window.escAttr(webhookId)}','${window.escAttr(d.id)}')">Retry</button>`
          : '';
        return `
          <div><span style="color:${stateColor(d.state)};font-weight:600;text-transform:uppercase;font-family:'DM Mono',monospace">${d.state}</span></div>
          <div style="font-family:'DM Mono',monospace;color:var(--ink2)">${window.escHtml(d.event)}</div>
          <div style="font-family:'DM Mono',monospace;color:var(--ink)">${d.attempts}</div>
          <div style="font-family:'DM Mono',monospace;color:var(--ink2)">${last}</div>
          <div style="font-family:'DM Mono',monospace;color:var(--ink3)">${fmtTs(d.last_attempt_at)}</div>
          <div style="font-family:'DM Mono',monospace;color:var(--ink3)">${d.state === 'pending' ? fmtTs(d.next_attempt_at) : '—'}</div>
          <div>${retryBtn}</div>
        `;
      }).join('')}
    </div>`;
}

export async function retryWebhookDelivery(webhookId, deliveryId) {
  try {
    await apiPost(`/api/v1/integrations/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`);
    // Refresh the modal in-place so the row flips to pending with
    // attempts=0 and a fresh next_attempt_at. The worker tick will
    // fire on the next ~5s cycle.
    await loadOutgoingWebhookDeliveries(webhookId);
  } catch (err) {
    alert(`Couldn't re-queue: ${err?.message || err}`);
  }
}

// ─── Edit modal ─────────────────────────────────────────────────────────
//
// Opens a modal pre-populated from OUTGOING_WEBHOOKS (no server fetch
// needed — the list is already in module state). Form fields share an
// `we-*` prefix so we don't collide with the inline create form's
// `wh-*` fields. Save and Rotate-secret are separate actions; the
// rotate flow surfaces the new secret in the same one-shot banner
// the create flow uses.

export function editOutgoingWebhook(id) {
  if (!window.isAdmin()) return;
  const w = OUTGOING_WEBHOOKS.find((x) => x.id === id);
  if (!w) return;
  const eventCheckboxes = SLACK_EVENTS.map((e) => `
    <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">
      <input type="checkbox" id="we-evt-${e.k}" ${w.events.includes(e.k) ? 'checked' : ''}/>
      ${window.escHtml(e.l)}
    </label>`).join('');
  // onConfirm-with-callback is avoided here: showModal's .toString()
  // round-trip loses our module-scope imports (apiPatch in particular),
  // so the buttons are inlined into the body and routed through the
  // window bridge instead.
  showModal(`Edit webhook · ${window.escHtml(w.name)}`,
    `<input type="hidden" id="we-id" value="${window.escAttr(w.id)}"/>
     <div class="form-row">
       <label class="form-label">Name</label>
       <input class="form-input" id="we-name" value="${window.escAttr(w.name)}"/>
     </div>
     <div class="form-row">
       <label class="form-label">URL</label>
       <input class="form-input" id="we-url" type="url" value="${window.escAttr(w.url)}"/>
     </div>
     <div class="form-row">
       <label class="form-label">Events</label>
       ${eventCheckboxes}
     </div>
     <div class="form-row" style="display:flex;align-items:center;gap:8px">
       <label class="toggle"><input type="checkbox" id="we-active" ${w.active ? 'checked' : ''}/><span class="toggle-slider"></span></label>
       <span style="font-size:13px;color:var(--ink2)">Active</span>
     </div>
     <div style="display:flex;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--rule)">
       <button class="btn" onclick="closeModal()">Cancel</button>
       <button class="btn btn-solid" onclick="saveOutgoingWebhookEdit()">Save</button>
       <span id="we-msg" style="margin-left:auto;font-size:11px;font-family:'DM Mono',monospace;color:var(--ink3)"></span>
     </div>
     <div style="margin-top:18px;padding:12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r)">
       <div style="font-size:12px;font-weight:600;color:var(--ink);margin-bottom:6px">Rotate signing secret</div>
       <div style="font-size:11px;color:var(--ink3);margin-bottom:10px;line-height:1.5">
         Generates a fresh secret and invalidates the old one immediately. In-flight retries will start failing HMAC verification at the receiver until you update its configuration.
       </div>
       <button class="btn btn-sm btn-danger" onclick="rotateOutgoingWebhookSecret()">Rotate secret</button>
     </div>`,
    null, null, true,
  );
}

// onConfirm callback. Module-scope so showModal's .toString() roundtrip
// resolves it via the window bridge. Reads the form by id rather than
// closing over the webhook record (see modal.js comment).
export async function saveOutgoingWebhookEdit() {
  const id     = document.getElementById('we-id').value;
  const name   = document.getElementById('we-name').value.trim();
  const url    = document.getElementById('we-url').value.trim();
  const events = SLACK_EVENTS.filter((e) => document.getElementById(`we-evt-${e.k}`)?.checked).map((e) => e.k);
  const active = document.getElementById('we-active').checked;
  const msg = document.getElementById('we-msg');
  if (!name) { msg.textContent = 'Name is required'; msg.style.color = 'var(--red)'; return; }
  if (!url)  { msg.textContent = 'URL is required';  msg.style.color = 'var(--red)'; return; }
  if (events.length === 0) { msg.textContent = 'Pick at least one event'; msg.style.color = 'var(--red)'; return; }
  try {
    const res = await apiPatch(`/api/v1/integrations/webhooks/${encodeURIComponent(id)}`, { name, url, events, active });
    // Replace the row in module state so the panel re-renders with
    // the new values without a full refetch.
    OUTGOING_WEBHOOKS = OUTGOING_WEBHOOKS.map((w) => w.id === id ? { ...w, ...res.webhook } : w);
    window.closeModal();
    window.renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

export async function rotateOutgoingWebhookSecret() {
  const id = document.getElementById('we-id').value;
  if (!confirm('Rotate the signing secret? The current secret will stop working immediately.')) return;
  const msg = document.getElementById('we-msg');
  msg.textContent = 'Rotating...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPatch(`/api/v1/integrations/webhooks/${encodeURIComponent(id)}`, { rotate_secret: true });
    // Surface the new secret via the same one-shot banner used by
    // create — close the modal so the user can see it on the panel.
    LAST_REVEALED_SECRET = res.secret;
    OUTGOING_WEBHOOKS = OUTGOING_WEBHOOKS.map((w) => w.id === id ? { ...w, ...res.webhook } : w);
    window.closeModal();
    window.renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Rotation failed';
    msg.style.color = 'var(--red)';
  }
}

export async function saveSlackIntegration() {
  if (!window.isAdmin()) return;
  const url           = document.getElementById('slack-url').value.trim();
  const channel       = document.getElementById('slack-channel').value.trim();
  const active        = document.getElementById('slack-active').checked;
  const events        = SLACK_EVENTS.filter((e) => document.getElementById(`slack-evt-${e.k}`)?.checked).map((e) => e.k);
  const botToken      = document.getElementById('slack-bot-token')?.value.trim() || '';
  const signingSecret = document.getElementById('slack-signing-secret')?.value.trim() || '';
  const msg = document.getElementById('slack-msg');
  if (!url) { msg.textContent = 'Webhook URL is required'; msg.style.color = 'var(--red)'; return; }
  if (events.length === 0) { msg.textContent = 'Pick at least one event'; msg.style.color = 'var(--red)'; return; }
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    // Only send bot_token / signing_secret when the user actually
    // typed something — sending undefined leaves the server-side value
    // alone, which is what we want for "save settings without
    // rotating credentials".
    const body = {
      webhook_url: url,
      channel:     channel || null,
      active,
      events,
    };
    if (botToken)      body.bot_token      = botToken;
    if (signingSecret) body.signing_secret = signingSecret;
    await apiPut('/api/v1/integrations/slack', body);
    const res = await apiGet('/api/v1/integrations/slack');
    SLACK_INTEGRATION = res.integration;
    document.getElementById('slack-bot-token').value = '';
    document.getElementById('slack-signing-secret').value = '';
    msg.textContent = 'Saved'; msg.style.color = 'var(--green)';
    window.renderPage('settings');
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
