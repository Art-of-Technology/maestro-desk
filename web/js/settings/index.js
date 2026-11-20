import { can } from '../core/permissions.js';
import { settingsSpamContacts } from './spam-contacts.js';
import { renderPersonalAppearance, cancelAppearancePreview } from './personal-appearance.js';
// ─── Settings ────────────────────────────────────────────────────────────────
// Settings groups personal preferences, brand settings and workspace tools.
// The "Knowledge Base" tab configures the
// KB_INTEGRATION object that lives in app.js — the rest of the KB
// integration code (fetchKbArticles, KB_TICKET_CACHE, refresh path) stays
// in app.js because the composer and ticket sidebar also depend on it.
//
// External reaches (interim, via window): isAdmin, escAttr, escHtml — all
// still in app.js. navTo is a direct ES import.
// refreshNotifBadge, setAIModel, setAgentPreferredLang,
// KB_INTEGRATION, KB_TICKET_CACHE, saveKbIntegration, fetchKbArticles are
// direct ES imports.
//
// No window-bridge namespace spread: the page's inline on*= handlers are
// delegated as settings.* actions (bottom of file). renderSettings is the
// router entry; setSettingsTab stays exported (ai/page + help import it) AND
// as an explicit app.js bridge entry, because notifications reaches it via
// window.setSettingsTab to dodge the settings↔notifications import cycle
// (settings already imports refreshNotifBadge from notifications).

import { CATEGORIES } from '../core/data.js';
import { NOTIF_PREFS, SESSION, SETTINGS_TAB, setSettingsTabValue } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { AI_MODEL, AI_MODELS, setAIModel, getAIStatus, checkAIConnection, checkAIGeneration } from '../ai/client.js';
import {
  AGENT_PREFERRED_LANG, TRANSLATOR_LANGS, setAgentPreferredLang,
} from '../ai/translate.js';
import { refreshNotifBadge } from '../notifications/index.js';
import { renderSoundSettings } from '../notifications/sound.js';
import { apiGet, apiPost, apiPatch, API_BASE, getWorkspaceId, getJwt } from '../core/api-client.js';
import { KB_INTEGRATION, KB_TICKET_CACHE, saveKbIntegration, fetchKbArticles } from '../kb-integration/index.js';
import { settingsEmailBranding, settingsMySignature } from '../email-branding/index.js';
import { settingsSenderDomain } from '../email-domain/index.js';
import { settingsPushSection } from '../push/index.js';
import { settingsReplyFeedback } from './reply-feedback.js';
import { registerActions, registerChangeActions, registerInputActions } from '../core/event-delegation.js';

let WORKSPACE_SETTINGS = null;
let WORKSPACE_SETTINGS_LOADED = false;
let ME_PREFS = null;
let ME_PREFS_LOADED = false;
let CATEGORIES_LOADED = false;   // Categories tab lazy-load guard

// Module-scoped state for the Settings → Knowledge Base test panel. Kept off
// `window` so it doesn't pollute the global namespace.
let KB_TEST_STATE = null;

export function renderSettings() {
  if (SETTINGS_TAB !== 'display') cancelAppearancePreview();
  const tabs = [
    {k:'profile',       l:'Profile'},
    {k:'notifications', l:'Notifications'},
    {k:'language',      l:'Language'},
    {k:'display',       l:'Appearance'},
    {k:'appearance',    l:'Brand & portal', heading:'Brand settings'},
    ...(can('admin.settings') ? [{k:'email', l:'Email branding'}] : []),
    ...(can('admin.integrations') ? [{k:'sender-domain', l:'Sender domain'}] : []),
    {k:'ai',            l:'AI Assistant', heading:'Workspace'},
    {k:'knowledge-base', l:'Knowledge Base'},
    ...(can('customers.view') && can('customers.spam') ? [{k:'spam-contacts', l:'Spam contacts'}] : []),
    ...(can('data.ai_reports') ? [{k:'reply-feedback', l:'Reply feedback'}] : []),
    ...(can('admin.inboxes') ? [{k:'categories', l:'Categories'}] : []),
  ];
  const tabbar = tabs.map(t => {
    return `${t.heading ? `<h2 class="settings-nav-heading">${t.heading}</h2>` : ''}<button type="button" class="settings-tab ${SETTINGS_TAB===t.k?'active':''}" ${SETTINGS_TAB===t.k?'aria-current="page"':''} data-action="settings.setTab" data-tab="${window.escAttr(t.k)}">${t.l}</button>`;
  }).join('');
  let panel = '';
  if      (SETTINGS_TAB === 'profile')       panel = settingsProfile();
  else if (SETTINGS_TAB === 'display')       panel = renderPersonalAppearance();
  else if (SETTINGS_TAB === 'appearance')    panel = settingsAppearance();
  else if (SETTINGS_TAB === 'notifications') panel = settingsNotifications();
  else if (SETTINGS_TAB === 'ai')            panel = settingsAI();
  else if (SETTINGS_TAB === 'knowledge-base') panel = settingsKnowledgeBase();
  else if (SETTINGS_TAB === 'language')      panel = settingsLanguage();
  else if (SETTINGS_TAB === 'spam-contacts') panel = settingsSpamContacts();
  else if (SETTINGS_TAB === 'email')         panel = settingsEmailBranding();
  else if (SETTINGS_TAB === 'sender-domain') panel = settingsSenderDomain();
  else if (SETTINGS_TAB === 'categories')    panel = settingsCategories();
  else if (SETTINGS_TAB === 'reply-feedback') panel = settingsReplyFeedback();
  return `
    <div class="page" data-guide="preferences">
      <div class="topbar"><div class="tb-title">Settings</div></div>
      <div class="page-scroll">
        <div class="settings-shell ${['ai','reply-feedback'].includes(SETTINGS_TAB) ? 'ai-settings-shell' : ''}">
          <aside class="settings-side">${tabbar}</aside>
          <div class="settings-panel">${panel}</div>
        </div>
      </div>
    </div>`;
}

export function setSettingsTab(k) { setSettingsTabValue(k); renderPage('settings'); }

function settingsProfile() {
  return `
    <div class="settings-section">
      <div class="settings-h">Account</div>
      <div style="display:flex;gap:12px;align-items:center;padding:8px 0 18px;border-bottom:1px solid var(--rule);margin-bottom:18px">
        <div style="width:48px;height:48px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;font-size:14px">${SESSION?.initials||'??'}</div>
        <div>
          <div style="font-size:15px;font-weight:600;color:var(--ink)">${SESSION?.name||'—'}</div>
          <div style="font-size:12px;color:var(--ink3)">${SESSION?.role||'—'}</div>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">Display name</label>
        <input class="form-input" id="set-name" value="${SESSION?.name||''}" data-input-action="settings.updateName"/>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">Initials</label>
          <input class="form-input" id="set-initials" value="${SESSION?.initials||''}" maxlength="3" data-input-action="settings.updateInitials"/>
        </div>
        <div class="form-row">
          <label class="form-label">Role</label>
          <input class="form-input" value="${SESSION?.role||''}" disabled style="opacity:.6"/>
        </div>
      </div>
    </div>
    ${settingsMySignature()}`;
}

function updateProfileName(name) {
  const trimmed = name.trim();
  if (!SESSION || !trimmed) return;
  SESSION.name = trimmed;
  const c = document.getElementById('pf-name-sm'); if (c) c.textContent = trimmed;
  const d = document.getElementById('pf-name-lg'); if (d) d.textContent = trimmed;
}
function updateProfileInitials(v) {
  const trimmed = v.trim().toUpperCase();
  if (!SESSION || !trimmed) return;
  SESSION.initials = trimmed;
  const av2 = document.getElementById('pf-av-sm'); if (av2) av2.textContent = trimmed;
  const av3 = document.getElementById('pf-av-lg'); if (av3) av3.textContent = trimmed;
}

function settingsAppearance() {
  return settingsWorkspaceBranding();
}

function settingsWorkspaceBranding() {
  // Reuses the same workspace settings state lazy-loaded by the AI
  // Assistant tab (PR #222). Either tab triggers the fetch; whichever
  // lands first wins, the other paints from cache.
  if (!WORKSPACE_SETTINGS_LOADED) {
    WORKSPACE_SETTINGS_LOADED = true;
    apiGet('/api/v1/workspace/settings')
      .then((res) => { WORKSPACE_SETTINGS = res.workspace; renderPage('settings'); })
      .catch((err) => { console.warn('[settings] workspace load failed:'); });
  }
  const ws = WORKSPACE_SETTINGS;
  const isAdmin = can('admin.settings');
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
          <button class="btn btn-sm" data-action="settings.uploadLogo" ${isAdmin ? '' : 'disabled'}>Upload</button>
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
          <input class="form-input" id="brand-primary-color" type="text" value="${window.escAttr(color)}" placeholder="#130e30" style="font-family:'DM Mono',monospace;max-width:140px" ${isAdmin ? '' : 'disabled'}/>
          <input type="color" id="brand-primary-color-picker" value="${color || '#130e30'}" data-input-action="settings.syncBrandColor" ${isAdmin ? '' : 'disabled'} style="width:34px;height:34px;border:1px solid var(--rule);border-radius:4px;padding:0;cursor:pointer;background:none"/>
        </div>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Hex like <code style="font-family:'DM Mono',monospace">#130e30</code>. Used for chips, focus rings, and the AI-draft button. Empty falls back to the default accent.</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-solid btn-sm" data-action="settings.saveBranding" ${isAdmin ? '' : 'disabled'}>Save</button>
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
        <label class="form-label">Footer <span style="color:var(--ink3);font-weight:400;font-family:'DM Mono',monospace;font-size:11px">— replaces "Powered by Respovia"</span></label>
        <input class="form-input" id="brand-portal-footer" type="text" maxlength="500" value="${window.escAttr(footer)}" placeholder="© Your Company 2026 · Need urgent help? Call +1 555 0100" ${isAdmin ? '' : 'disabled'}/>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-solid btn-sm" data-action="settings.savePortalCopy" ${isAdmin ? '' : 'disabled'}>Save portal copy</button>
        <span id="portal-copy-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;align-self:center"></span>
      </div>
    </div>

    ${settingsPortalDomain(ws, isAdmin)}`;
}

function settingsPortalDomain(ws, isAdmin) {
  const domain   = ws?.portal_custom_domain || '';
  const token    = ws?.portal_custom_domain_token || '';
  const verified = ws?.portal_custom_domain_verified === true;
  const recordName = domain ? `_maestro-verify.${domain}` : '';
  const verifiedPill = verified
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:3px;background:var(--green-lt);color:var(--green);font-size:10px;font-weight:600;text-transform:uppercase;font-family:'DM Mono',monospace">Verified</span>`
    : `<span style="display:inline-block;padding:2px 8px;border-radius:3px;background:var(--amber-lt);color:var(--amber);font-size:10px;font-weight:600;text-transform:uppercase;font-family:'DM Mono',monospace">Pending</span>`;
  return `
    <div class="settings-section">
      <div class="settings-h">Custom portal domain</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        Serve the customer portal at your own hostname (e.g. <code style="font-family:'DM Mono',monospace">help.acme.com</code>) instead of the platform URL. TLS is on you — point a CDN at this server's portal host. Verification is via a TXT record so we know you control the domain.
      </div>
      <div class="form-row">
        <label class="form-label">Custom hostname</label>
        <div style="display:flex;align-items:center;gap:10px">
          <input class="form-input" id="brand-portal-domain" type="text" value="${window.escAttr(domain)}" placeholder="help.acme.com" ${isAdmin ? '' : 'disabled'} style="font-family:'DM Mono',monospace;flex:1"/>
          ${domain ? verifiedPill : ''}
        </div>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Lowercase, fully-qualified (at least one dot). Changing this re-issues the verification token and resets the verified state.</div>
      </div>
      ${domain && token ? `
        <div style="margin:14px 0;padding:12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);font-size:12px;line-height:1.6">
          <div style="font-weight:600;color:var(--ink);margin-bottom:8px">DNS verification</div>
          <div style="color:var(--ink2);margin-bottom:10px">Add a TXT record at:</div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;background:var(--w);padding:8px 10px;border-radius:3px;border:1px solid var(--rule);user-select:all;margin-bottom:6px">${window.escHtml(recordName)}</div>
          <div style="color:var(--ink2);margin-bottom:10px">with the value:</div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;background:var(--w);padding:8px 10px;border-radius:3px;border:1px solid var(--rule);user-select:all;word-break:break-all">${window.escHtml(token)}</div>
        </div>
      ` : ''}
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-solid btn-sm" data-action="settings.savePortalDomain" ${isAdmin ? '' : 'disabled'}>Save hostname</button>
        ${domain ? `<button class="btn btn-sm" data-action="settings.verifyPortalDomain" ${isAdmin ? '' : 'disabled'}>${verified ? 'Re-verify' : 'Verify now'}</button>` : ''}
        <span id="portal-domain-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;align-self:center"></span>
      </div>
    </div>`;
}

async function savePortalDomain() {
  if (!can('admin.settings')) return;
  const domain = document.getElementById('brand-portal-domain').value.trim().toLowerCase();
  const msg = document.getElementById('portal-domain-msg');
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPatch('/api/v1/workspace/settings', {
      portal_custom_domain: domain || null,
    });
    WORKSPACE_SETTINGS = res.workspace;
    msg.textContent = '✓ Saved';
    msg.style.color = 'var(--green)';
    renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

async function verifyPortalDomain() {
  if (!can('admin.settings')) return;
  const msg = document.getElementById('portal-domain-msg');
  msg.textContent = 'Looking up DNS...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPost('/api/v1/workspace/domain/verify');
    if (res.verified) {
      msg.textContent = '✓ Verified';
      msg.style.color = 'var(--green)';
      const fresh = await apiGet('/api/v1/workspace/settings');
      WORKSPACE_SETTINGS = fresh.workspace;
      renderPage('settings');
    } else {
      const reason = res.reason === 'no_txt_record'
        ? `No TXT record at ${res.record_name}`
        : res.reason === 'mismatch'
          ? `TXT record found but value didn't match the expected token`
          : `DNS lookup failed (${res.reason})`;
      msg.textContent = reason;
      msg.style.color = 'var(--red)';
    }
  } catch (err) {
    msg.textContent = err?.message || 'Verification failed';
    msg.style.color = 'var(--red)';
  }
}

async function savePortalCopy() {
  if (!can('admin.settings')) return;
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

async function uploadWorkspaceLogo() {
  if (!can('admin.settings')) return;
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
    renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Upload failed';
    msg.style.color = 'var(--red)';
  }
}

async function saveWorkspaceBranding() {
  if (!can('admin.settings')) return;
  const logoUrl = document.getElementById('brand-logo-url').value.trim();
  const color   = document.getElementById('brand-primary-color').value.trim();
  const msg = document.getElementById('brand-msg');
  if (logoUrl && !/^https?:\/\//i.test(logoUrl)) {
    msg.textContent = 'Logo URL must start with https://';
    msg.style.color = 'var(--red)';
    return;
  }
  if (color && !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)) {
    msg.textContent = 'Color must be a hex like #130e30';
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
    renderPage('settings');
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
    {k:'response',  l:'New customer responses', d:'A customer replied to a ticket assigned to you'},
    {k:'unassigned', l:'Unassigned tickets', d:'Outstanding tickets that need an owner; paused while snoozed'},
  ];
  // Email preferences live server-side (per-user, on public.users).
  // Lazy-load on tab open + re-render once the fetch lands so the
  // toggle reflects the persisted value.
  if (!ME_PREFS_LOADED) {
    ME_PREFS_LOADED = true;
    apiGet('/api/v1/me')
      .then((res) => { ME_PREFS = res.user; renderPage('settings'); })
      .catch((err) => { console.warn('[settings] me load failed:'); });
  }
  const mentionEmailOn = ME_PREFS ? ME_PREFS.mention_email_enabled !== false : true;
  const assignmentEmailOn = ME_PREFS ? ME_PREFS.assignment_email_enabled !== false : true;
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
            <input type="checkbox" aria-label="${window.escAttr(t.l)}" ${NOTIF_PREFS[t.k]?'checked':''} data-change-action="settings.toggleNotif" data-key="${t.k}">
            <span class="toggle-slider"></span>
          </label>
        </div>`).join('')}
    </div>

    ${renderSoundSettings()}
    <div class="settings-section email-notification-settings">
      <div class="settings-h">Email notifications</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Choose when we email you outside the app. Saved to your account, applies across devices.</div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">@mention emails</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">A teammate @-mentions you in an internal note.</div>
        </div>
        <label class="toggle">
          <input type="checkbox" aria-label="Mention emails" ${mentionEmailOn ? 'checked' : ''} data-change-action="settings.setMentionEmail">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Assignment emails</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">A ticket is assigned to you by a teammate or an assignment rule.</div>
        </div>
        <label class="toggle">
          <input type="checkbox" aria-label="Assignment emails" ${assignmentEmailOn ? 'checked' : ''} data-change-action="settings.setAssignmentEmail">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div id="email-notification-msg" role="status" style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;margin-top:8px;min-height:14px"></div>
    </div>
    ${settingsPushSection()}`;
}

async function setEmailPref(key, enabled) {
  const msg = document.getElementById('email-notification-msg');
  if (msg) { msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)'; }
  try {
    const res = await apiPatch('/api/v1/me', { [key]: enabled });
    ME_PREFS = res.user;
    if (msg) { msg.textContent = enabled ? '✓ Enabled' : '✓ Disabled'; msg.style.color = 'var(--green)'; }
  } catch (err) {
    if (msg) { msg.textContent = err?.message || 'Save failed'; msg.style.color = 'var(--red)'; }
    // Revert UI if the patch failed.
    ME_PREFS_LOADED = false;
    renderPage('settings');
  }
}

function toggleNotifPref(k, v) {
  NOTIF_PREFS[k] = v;
  localStorage.setItem('notif_prefs', JSON.stringify(NOTIF_PREFS));
  refreshNotifBadge();
}

function settingsAI() {
  // The status node belongs to this render; late responses cannot update a
  // different workspace or a subsequently rendered settings screen.
  queueMicrotask(() => refreshAIStatus());
  return `
    <div class="settings-section ai-settings">
      <div class="settings-h">AI Assistant</div>
      <p style="font-size:12px;color:var(--ink3);line-height:1.5">Draft replies, summarise tickets, translate messages and chat about your workspace using Respovia’s shared Claude connection.</p>
      <div class="form-row">
        <label class="form-label" for="set-ai-model">Model for your AI requests</label>
        <select id="set-ai-model" class="form-input" data-change-action="settings.setAiModel">
          ${AI_MODELS.map(m => `<option value="${m.v}" ${AI_MODEL===m.v?'selected':''}>${m.l}</option>`).join('')}
        </select>
      </div>
      <div id="ai-settings-status" role="status" aria-live="polite" style="font-size:12px;line-height:1.6">Checking workspace settings…</div>
      <button class="btn btn-sm" data-action="settings.checkAi" style="margin-top:12px">Check key and model (free)</button>
      <button class="btn btn-sm" data-action="settings.checkAiGeneration" style="margin-top:12px">Test AI generation…</button>
      <div id="ai-connection-result" role="status" aria-live="polite" style="font-size:12px;margin-top:8px"></div>
      <p style="font-size:11px;color:var(--ink3)">The free check does not test generation or billing credit. The generation test sends fixed test text with no customer data and uses a small amount of provider and workspace credit.</p>
      <div class="settings-row">
        <div><div style="font-size:13px">Include player account details</div>
        <div style="font-size:11px;color:var(--ink3)">Allow VIP tier, brand and jurisdiction in AI context. Ticket text is still sent when this is off. AML data is excluded. Workspace admins can change this setting.</div></div>
        <label class="toggle"><input id="ai-player-enrichment" type="checkbox" aria-label="Include player account details" disabled data-change-action="settings.setAiEnrichment"><span class="toggle-slider"></span></label>
      </div>
      <div id="ai-privacy-result" role="status" aria-live="polite" style="font-size:12px"></div>
    </div>`;
}

async function refreshAIStatus() {
  const node = document.getElementById('ai-settings-status');
  const toggle = document.getElementById('ai-player-enrichment');
  const ws = getWorkspaceId(), jwt = getJwt();
  if (!node) return;
  try {
    const status = await getAIStatus();
    if (!node.isConnected || ws !== getWorkspaceId() || jwt !== getJwt()) return;
    node.textContent = (status.configured ? 'Server key configured.' : 'Server key needs configuration.')
      + ' Workspace credit: $' + (status.balance_micro / 1000000).toFixed(4)
      + '. Your platform administrator manages credit.';
    if (toggle) { toggle.checked = status.player_enrichment; toggle.disabled = !can('admin.settings'); }
  } catch (err) {
    if (node.isConnected && ws === getWorkspaceId() && jwt === getJwt()) node.textContent = err?.message || 'Could not load AI settings.';
  }
}

async function testAIConnection(generation = false) {
  const node = document.getElementById('ai-connection-result');
  const ws = getWorkspaceId(), jwt = getJwt();
  if (!node || node.dataset.checking === 'true') return;
  if (generation && !window.confirm('Test AI generation? This sends fixed test text with no customer data and uses a small amount of provider and workspace credit.')) return;
  const model = AI_MODEL;
  node.dataset.checking = 'true';
  node.textContent = generation ? 'Testing AI generation…' : 'Checking key and model…';
  try {
    const result = await (generation ? checkAIGeneration() : checkAIConnection());
    if (generation && result.generation_verified !== true) throw new Error('AI generation was not verified. Try again.');
    if (node.isConnected && ws === getWorkspaceId() && jwt === getJwt() && model === AI_MODEL) node.textContent = generation
      ? 'AI generated a test response successfully. This confirms it worked at the time of this test.'
      : 'Key and model access verified. Generation and billing credit have not been tested.';
  } catch (err) {
    if (node.isConnected && ws === getWorkspaceId() && jwt === getJwt() && model === AI_MODEL) node.textContent = err?.message || 'Connection failed.';
  } finally { delete node.dataset.checking; }
  refreshAIStatus();
}

async function setAIEnrichment(el) {
  const node = document.getElementById('ai-privacy-result');
  const ws = getWorkspaceId(), jwt = getJwt();
  el.disabled = true;
  try {
    await apiPatch('/api/v1/workspace/settings', { ai_player_enrichment: el.checked });
    if (node?.isConnected && ws === getWorkspaceId() && jwt === getJwt()) node.textContent = 'Player data setting saved.';
  } catch (err) {
    if (node?.isConnected && ws === getWorkspaceId() && jwt === getJwt()) node.textContent = err?.message || 'Could not save the setting.';
  }
  refreshAIStatus();
}

function settingsKnowledgeBase() {
  const cfg = KB_INTEGRATION;
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
        <label class="toggle"><input type="checkbox" ${cfg.enabled?'checked':''} data-change-action="settings.setKbCfg" data-key="enabled"><span class="toggle-slider"></span></label>
      </div>
      <div class="form-row"><label class="form-label">Base URL</label>
        <input class="form-input" id="kb-base-url" placeholder="https://kb.example.com/api/v1" value="${esc(cfg.baseUrl)}" data-input-action="settings.setKbCfg" data-key="baseUrl"/>
      </div>
      <div class="form-row"><label class="form-label">Search path <span style="color:var(--ink3);font-family:'DM Mono',monospace;font-size:11px;font-weight:400">— use {query} as placeholder</span></label>
        <input class="form-input" id="kb-search-path" placeholder="/articles?q={query}&amp;limit=5" value="${esc(cfg.searchPath)}" data-input-action="settings.setKbCfg" data-key="searchPath"/>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Auth header (optional)</label>
          <input class="form-input" placeholder="Authorization" value="${esc(cfg.authHeader)}" data-input-action="settings.setKbCfg" data-key="authHeader"/>
        </div>
        <div class="form-row"><label class="form-label">Header prefix</label>
          <input class="form-input" placeholder="Bearer " value="${esc(cfg.authPrefix)}" data-input-action="settings.setKbCfg" data-key="authPrefix"/>
        </div>
      </div>
      <div class="form-row"><label class="form-label">API key / token (optional)</label>
        <input class="form-input" type="password" placeholder="—" value="${esc(cfg.apiKey)}" data-input-action="settings.setKbCfg" data-key="apiKey" autocomplete="off"/>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-h">Response shape</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Tell the adapter where to find articles inside the JSON response. Field names support dot notation (e.g. <code style="font-family:'DM Mono',monospace">data.items</code>).</div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Results path</label>
          <input class="form-input" placeholder="(empty = response root)" value="${esc(cfg.resultsField)}" data-input-action="settings.setKbCfg" data-key="resultsField"/>
        </div>
        <div class="form-row"><label class="form-label">Max results</label>
          <input class="form-input" type="number" min="1" max="20" value="${cfg.maxResults}" data-input-action="settings.setKbCfg" data-key="maxResults"/>
        </div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">ID field</label><input class="form-input" value="${esc(cfg.idField)}" data-input-action="settings.setKbCfg" data-key="idField"/></div>
        <div class="form-row"><label class="form-label">Title field</label><input class="form-input" value="${esc(cfg.titleField)}" data-input-action="settings.setKbCfg" data-key="titleField"/></div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Body field</label><input class="form-input" value="${esc(cfg.bodyField)}" data-input-action="settings.setKbCfg" data-key="bodyField"/></div>
        <div class="form-row"><label class="form-label">URL field</label><input class="form-input" value="${esc(cfg.urlField)}" data-input-action="settings.setKbCfg" data-key="urlField"/></div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-h">Test connection</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Send a sample query against the configured endpoint to verify the path, auth, and field mapping.</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="form-input" id="kb-test-q" placeholder="e.g. password reset" style="flex:1;min-width:200px" value="${esc(testState?.query || 'password reset')}"/>
        <button class="btn btn-sm" data-action="settings.testKb" ${cfg.enabled?'':'disabled'}>Run test</button>
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

function setKbCfg(key, value) {
  KB_INTEGRATION[key] = value;
  saveKbIntegration();
  KB_TICKET_CACHE.clear();
}

async function testKbConnection() {
  const q = document.getElementById('kb-test-q')?.value?.trim() || 'password reset';
  KB_TEST_STATE = { query: q, loading: true };
  renderPage('settings');
  const result = await fetchKbArticles(q);
  KB_TEST_STATE = { query: q, articles: result.articles || [], error: result.error || null };
  renderPage('settings');
}

function settingsLanguage() {
  return `
    <div class="settings-section">
      <div class="settings-h">Your reading language</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">When ticket-thread translation is enabled (toggle above the conversation), the conversation renders in this language. Replies you compose can also be auto-translated to the customer's language before sending. Saved language checks and translations are reused in this browser until you sign out. AI credit is managed in <span class="link" data-action="settings.setTab" data-tab="ai">AI Assistant</span>.</div>
      <div class="form-row">
        <label class="form-label">Preferred language</label>
        <select class="form-input" id="set-pref-lang" data-change-action="settings.setLang">
          ${TRANSLATOR_LANGS.map(l => `<option value="${l}" ${AGENT_PREFERRED_LANG===l?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>
      <div style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;margin-top:8px">
        Preferred language: ${AGENT_PREFERRED_LANG}. Uses your workspace AI connection.
      </div>
    </div>`;
}

// ─── Delegated actions ──────────────────────────────────────────────────────
// All settings panels are injected via innerHTML, so the document-level
// dispatcher in core/event-delegation.js catches these. setSettingsTab is the
// one export that stays window-reachable (explicit app.js bridge entry) for
// notifications' cross-module reach.
const setKbCfgHandler = (ds, el) => {
  let v;
  if (el.type === 'checkbox')        v = el.checked;
  else if (ds.key === 'maxResults')  v = parseInt(el.value, 10) || 3;
  else                               v = el.value;
  setKbCfg(ds.key, v);
};

// ─── Categories (admin) ────────────────────────────────────────────────────
// Manage the workspace's ticket categories: disable a default (reversible —
// hidden from new tickets + AI triage, history preserved) or create a new one.
// Backed by /api/v1/categories. Admin-only (the tab is gated in renderSettings).
function settingsCategories() {
  if (!CATEGORIES_LOADED) {
    CATEGORIES_LOADED = true;
    refreshCategories().catch((err) => console.warn('[settings] categories load failed:'));
  }
  const isAdmin = can('admin.inboxes');
  const sorted   = [...CATEGORIES].sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  const active   = sorted.filter((c) => c.is_active);
  const disabled = sorted.filter((c) => !c.is_active);

  const row = (c, nextActive) => `
    <div class="settings-row">
      <div style="font-size:13px;color:var(--ink)">${window.escHtml(c.label)}
        <span style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;margin-left:6px">${window.escHtml(c.key)}</span>
      </div>
      <button class="btn btn-sm" data-action="settings.toggleCategory" data-key="${window.escAttr(c.key)}" data-next="${nextActive}" ${isAdmin ? '' : 'disabled'}>${nextActive === 'true' ? 'Enable' : 'Disable'}</button>
    </div>`;

  const activeList = active.length
    ? active.map((c) => row(c, 'false')).join('')
    : `<div style="font-size:12px;color:var(--ink3);padding:8px 0">No active categories yet.</div>`;
  const disabledList = disabled.length
    ? `<div class="settings-h" style="margin-top:18px">Disabled</div>
       <div style="font-size:12px;color:var(--ink3);margin-bottom:8px">Hidden from new tickets and AI triage; existing tickets keep the category. Re-enable any time.</div>
       ${disabled.map((c) => row(c, 'true')).join('')}`
    : '';

  return `
    <div class="settings-section">
      <div class="settings-h">Ticket categories</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        The categories agents and AI triage can assign to tickets. Disable one to retire it without losing history; create new ones for your workflows. Admins only.
      </div>
      ${activeList}
      ${disabledList}
      <div class="form-row" style="margin-top:18px">
        <label class="form-label">Add a category</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input class="form-input" id="new-cat-label" type="text" maxlength="64" placeholder="e.g. Withdrawals" ${isAdmin ? '' : 'disabled'} style="flex:1"/>
          <button class="btn btn-solid btn-sm" data-action="settings.addCategory" ${isAdmin ? '' : 'disabled'}>Add</button>
        </div>
        <span id="cat-msg" style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;margin-top:6px;display:block"></span>
      </div>
    </div>`;
}

// Re-fetch the canonical category list (active + inactive) and repaint. The
// shared CATEGORIES array is mutated in place so the New-Ticket dropdown
// (which imports it) reflects changes too.
function refreshCategories() {
  return apiGet('/api/v1/categories').then((res) => {
    CATEGORIES.length = 0;
    for (const c of (res.categories || [])) CATEGORIES.push(c);
    renderPage('settings');
  });
}

// Write to the shared status line under the add-category form. Re-queries each
// call (refreshCategories repaints the panel) and no-ops safely if the element
// isn't present — both add + toggle route their feedback through here so an
// error is never dropped silently.
function setCatMsg(text, color) {
  const m = document.getElementById('cat-msg');
  if (m) { m.textContent = text; m.style.color = color; }
}

async function addCategory() {
  if (!can('admin.inboxes')) return;
  const input = document.getElementById('new-cat-label');
  const label = (input?.value || '').trim();
  if (!label) { setCatMsg('Enter a category name', 'var(--red)'); return; }
  setCatMsg('Adding…', 'var(--ink3)');
  try {
    await apiPost('/api/v1/categories', { label });
    await refreshCategories();   // repaints — clears the input + shows the new row
    setCatMsg('✓ Added', 'var(--green)');
  } catch (err) {
    // 409 carries a helpful message (incl. the re-enable hint for a disabled clash).
    setCatMsg(err?.message || 'Add failed', 'var(--red)');
  }
}

// nextActive is a real boolean here — the handler converts the stringy
// data-next attribute ('true'/'false') to a boolean before calling this.
async function toggleCategory(key, nextActive) {
  if (!can('admin.inboxes')) return;
  try {
    await apiPatch(`/api/v1/categories/${encodeURIComponent(key)}`, { is_active: nextActive });
    await refreshCategories();
  } catch (err) {
    setCatMsg(err?.message || 'Update failed', 'var(--red)');
  }
}

registerActions({
  'settings.checkAi':           () => testAIConnection(),
  'settings.checkAiGeneration': () => testAIConnection(true),
  'settings.setTab':             (ds) => setSettingsTab(ds.tab),
  // workspace branding / portal
  'settings.uploadLogo':        () => uploadWorkspaceLogo(),
  'settings.saveBranding':      () => saveWorkspaceBranding(),
  'settings.savePortalCopy':    () => savePortalCopy(),
  'settings.savePortalDomain':  () => savePortalDomain(),
  'settings.verifyPortalDomain':() => verifyPortalDomain(),
  // KB test
  'settings.testKb':            () => testKbConnection(),
  // categories (admin)
  'settings.addCategory':       () => addCategory(),
  'settings.toggleCategory':    (ds) => toggleCategory(ds.key, ds.next === 'true'),
});

registerChangeActions({
  'settings.setAiEnrichment': (ds, el) => setAIEnrichment(el),
  'settings.toggleNotif':   (ds, el) => toggleNotifPref(ds.key, el.checked),
  'settings.setMentionEmail':(ds, el) => setEmailPref('mention_email_enabled', el.checked),
  'settings.setAssignmentEmail':(ds, el) => setEmailPref('assignment_email_enabled', el.checked),
  'settings.setAiModel':    (ds, el) => { setAIModel(el.value); const node = document.getElementById('ai-connection-result'); if (node) node.textContent = ''; },
  'settings.setLang':       (ds, el) => setAgentPreferredLang(el.value),
  'settings.setKbCfg':      setKbCfgHandler,
});

registerInputActions({
  'settings.updateName':     (ds, el) => updateProfileName(el.value),
  'settings.updateInitials': (ds, el) => updateProfileInitials(el.value),
  'settings.setKbCfg':       setKbCfgHandler,
  // color picker → mirror its value into the hex text input
  'settings.syncBrandColor': (ds, el) => { const t = document.getElementById('brand-primary-color'); if (t) t.value = el.value; },
});
