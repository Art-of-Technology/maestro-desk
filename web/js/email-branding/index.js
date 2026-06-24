// Email branding settings — two surfaces, both rendered inside the Settings
// page (web/js/settings/index.js imports the two exported render functions):
//
//   • settingsEmailBranding() — admin-only "Email branding" tab. CRUD over the
//     workspace's brand header/footer templates, with a "set default" action
//     and a live preview. The logo is reused from Workspace branding.
//   • settingsMySignature() — a section in the Profile tab where each agent
//     manages their OWN signature(s) and picks a default.
//
// Outbound product emails (auto-reply, CSAT, @mention notifications, magic-
// link sign-in) are wrapped server-side with the default template's header +
// footer, plus — on agent-authored emails — that agent's default signature.

import { apiGet, apiPost, apiPatch, apiDelete } from '../core/api-client.js';
import { renderPage } from '../core/router.js';
import { showModal, closeModal } from '../core/modal.js';
import { registerActions } from '../core/event-delegation.js';

// ─── Module state ────────────────────────────────────────────────────────
let EB_TEMPLATES = [];
let EB_TEMPLATES_LOADED = false;
let EB_SIGS = [];
let EB_SIGS_LOADED = false;
// Logo URL for the preview — lazy-loaded from workspace settings.
let EB_LOGO_URL = null;
let EB_LOGO_LOADED = false;

function loadLogo() {
  if (EB_LOGO_LOADED) return;
  EB_LOGO_LOADED = true;
  apiGet('/api/v1/workspace/settings')
    .then((res) => { EB_LOGO_URL = res.workspace?.logo_url || null; renderPage('settings'); })
    .catch((err) => { console.warn('[email-branding] logo load failed:', err); });
}

// ─── Admin: brand header/footer templates ─────────────────────────────────

export function settingsEmailBranding() {
  const isAdmin = window.isAdmin();
  if (!EB_TEMPLATES_LOADED) {
    EB_TEMPLATES_LOADED = true;
    apiGet('/api/v1/email-branding/templates')
      .then((res) => { EB_TEMPLATES = res.templates || []; renderPage('settings'); })
      .catch((err) => { console.warn('[email-branding] templates load failed:', err); });
  }
  loadLogo();

  const rows = EB_TEMPLATES.length === 0
    ? `<div style="color:var(--ink3);font-size:12px;padding:14px 0;text-align:center">No templates yet. Add one to brand your outbound emails.</div>`
    : EB_TEMPLATES.map((t) => ebTemplateRow(t, isAdmin)).join('');

  const defaultTpl = EB_TEMPLATES.find((t) => t.is_default) || null;

  return `
    <div class="settings-section">
      <div class="settings-h">Email branding</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        Header and footer applied to outbound emails (auto-reply, CSAT surveys, @mention notifications, and customer sign-in links). The header can show your <span class="link" data-action="settings.setTab" data-tab="appearance">workspace logo</span>; the footer is good for an address, contact line, or legal notice. Mark one template as the <strong style="color:var(--ink2)">default</strong> to apply it everywhere. Admins only.
      </div>
      <div>${rows}</div>
      ${isAdmin ? `
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn btn-solid btn-sm" data-action="eb.newTemplate">Add template</button>
          <span id="eb-tpl-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;align-self:center"></span>
        </div>` : ''}
    </div>
    ${ebPreview(defaultTpl)}`;
}

function ebTemplateRow(t, isAdmin) {
  const esc = window.escHtml;
  const defaultPill = t.is_default
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:3px;background:var(--green-lt);color:var(--green);font-size:10px;font-weight:600;text-transform:uppercase;font-family:'DM Mono',monospace;margin-left:8px">Default</span>`
    : '';
  const snippet = [t.header_text, t.footer_text].filter(Boolean).join(' · ').slice(0, 90) || '(no header/footer text)';
  return `
    <div style="padding:10px 0;border-bottom:1px solid var(--rule);display:flex;align-items:center;gap:12px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;color:var(--ink);font-size:13px">${esc(t.name)}${defaultPill}</div>
        <div style="font-size:11px;color:var(--ink3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(snippet)}${t.show_logo ? '' : ' · logo hidden'}</div>
      </div>
      ${isAdmin ? `
        ${t.is_default ? '' : `<button class="btn btn-sm" data-action="eb.setDefaultTemplate" data-id="${window.escAttr(t.id)}">Set default</button>`}
        <button class="btn btn-sm" data-action="eb.editTemplate" data-id="${window.escAttr(t.id)}">Edit</button>
        <button class="btn btn-sm btn-danger" data-action="eb.deleteTemplate" data-id="${window.escAttr(t.id)}">Delete</button>
      ` : ''}
    </div>`;
}

function ebPreview(tpl) {
  const esc = window.escHtml;
  const logo = (tpl?.show_logo !== false && EB_LOGO_URL)
    ? `<img src="${window.escAttr(EB_LOGO_URL)}" alt="" style="max-height:40px;max-width:180px;display:block;margin-bottom:10px" onerror="this.style.display='none'"/>`
    : '';
  const header = tpl?.header_text ? `<div style="margin-bottom:10px;color:#1a1a22">${esc(tpl.header_text).replace(/\n/g, '<br>')}</div>` : '';
  const footer = tpl?.footer_text ? `<div style="margin-top:16px;padding-top:10px;border-top:1px solid #ececf1;color:#8a8a93;font-size:11px">${esc(tpl.footer_text).replace(/\n/g, '<br>')}</div>` : '';
  return `
    <div class="settings-section">
      <div class="settings-h">Preview</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">How the ${tpl ? 'default' : 'currently-unbranded'} email wraps a sample message.</div>
      <div style="background:#f4f4f7;border-radius:8px;padding:18px">
        <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:20px;font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a22">
          ${logo}${header}
          <div style="color:#1a1a22">Hi there,<br><br>Thanks for getting in touch — here's a sample of the message body your customers will read.</div>
          ${footer}
        </div>
      </div>
      ${!tpl ? `<div style="font-size:11px;color:var(--ink3);margin-top:8px;font-family:'DM Mono',monospace">No default template set — emails currently send as plain text.</div>` : ''}
    </div>`;
}

function ebTemplateForm(t) {
  const escA = window.escAttr;
  const escH = window.escHtml;
  const showLogo = t ? t.show_logo !== false : true;
  return `
    <div class="form-row">
      <label class="form-label">Template name</label>
      <input class="form-input" id="eb-tpl-name" value="${escA(t?.name || '')}" placeholder="e.g. Default brand"/>
    </div>
    <div class="form-row">
      <label class="form-label">Header text <span style="color:var(--ink3);font-weight:400;font-family:'DM Mono',monospace;font-size:11px">— optional, shown under the logo</span></label>
      <textarea class="form-input" id="eb-tpl-header" rows="2" maxlength="2000" placeholder="e.g. Acme Support" style="resize:vertical;font-family:inherit">${escH(t?.header_text || '')}</textarea>
    </div>
    <div class="form-row">
      <label class="form-label">Footer text <span style="color:var(--ink3);font-weight:400;font-family:'DM Mono',monospace;font-size:11px">— optional, address / contact / legal</span></label>
      <textarea class="form-input" id="eb-tpl-footer" rows="3" maxlength="2000" placeholder="© Acme Ltd · 123 Example St · support@acme.com" style="resize:vertical;font-family:inherit">${escH(t?.footer_text || '')}</textarea>
      <div style="font-size:11px;color:var(--ink3);margin-top:4px">Plain text. Links are made clickable automatically in the HTML email.</div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--ink2);margin-top:6px">
      <input type="checkbox" id="eb-tpl-logo" ${showLogo ? 'checked' : ''}/> Show the workspace logo in the header
    </label>
    ${t ? '' : `
      <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--ink2);margin-top:8px">
        <input type="checkbox" id="eb-tpl-default"/> Make this the default template
      </label>`}`;
}

function ebReadTemplateForm() {
  return {
    name:        document.getElementById('eb-tpl-name').value.trim(),
    header_text: document.getElementById('eb-tpl-header').value.trim() || null,
    footer_text: document.getElementById('eb-tpl-footer').value.trim() || null,
    show_logo:   document.getElementById('eb-tpl-logo').checked,
    is_default:  document.getElementById('eb-tpl-default')?.checked || false,
  };
}

function ebNewTemplate() {
  if (!window.isAdmin()) return;
  showModal('New email template', ebTemplateForm(null), async () => {
    const d = ebReadTemplateForm();
    if (!d.name) { alert('Template name is required.'); return; }
    try {
      const res = await apiPost('/api/v1/email-branding/templates', d);
      EB_TEMPLATES.push(res.template);
      if (res.template.is_default) EB_TEMPLATES.forEach((t) => { if (t.id !== res.template.id) t.is_default = false; });
    } catch (err) { alert(`Couldn't create: ${err?.message || err}`); return; }
    closeModal(); renderPage('settings');
  }, 'Create');
}

function ebEditTemplate(id) {
  if (!window.isAdmin()) return;
  const t = EB_TEMPLATES.find((x) => x.id === id);
  if (!t) return;
  showModal('Edit email template', ebTemplateForm(t), async () => {
    const d = ebReadTemplateForm();
    if (!d.name) { alert('Template name is required.'); return; }
    try {
      const res = await apiPatch(`/api/v1/email-branding/templates/${encodeURIComponent(id)}`, {
        name: d.name, header_text: d.header_text, footer_text: d.footer_text, show_logo: d.show_logo,
      });
      const i = EB_TEMPLATES.findIndex((x) => x.id === id);
      if (i >= 0) EB_TEMPLATES[i] = res.template;
    } catch (err) { alert(`Couldn't save: ${err?.message || err}`); return; }
    closeModal(); renderPage('settings');
  }, 'Save');
}

async function ebSetDefaultTemplate(id) {
  if (!window.isAdmin()) return;
  try {
    await apiPost(`/api/v1/email-branding/templates/${encodeURIComponent(id)}/default`);
    EB_TEMPLATES.forEach((t) => { t.is_default = t.id === id; });
    renderPage('settings');
  } catch (err) { alert(`Couldn't set default: ${err?.message || err}`); }
}

async function ebDeleteTemplate(id) {
  if (!window.isAdmin()) return;
  if (!confirm('Delete this template? Emails will fall back to the next default (or plain text).')) return;
  try {
    await apiDelete(`/api/v1/email-branding/templates/${encodeURIComponent(id)}`);
    EB_TEMPLATES = EB_TEMPLATES.filter((t) => t.id !== id);
    renderPage('settings');
  } catch (err) { alert(`Couldn't delete: ${err?.message || err}`); }
}

// ─── Per-agent: my signature ───────────────────────────────────────────────

export function settingsMySignature() {
  if (!EB_SIGS_LOADED) {
    EB_SIGS_LOADED = true;
    apiGet('/api/v1/email-branding/signatures')
      .then((res) => { EB_SIGS = res.signatures || []; renderPage('settings'); })
      .catch((err) => { console.warn('[email-branding] signatures load failed:', err); });
  }
  const rows = EB_SIGS.length === 0
    ? `<div style="color:var(--ink3);font-size:12px;padding:12px 0">No signature yet — add one to sign emails you send.</div>`
    : EB_SIGS.map((s) => ebSigRow(s)).join('');
  return `
    <div class="settings-section">
      <div class="settings-h">My email signature</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        Added to outbound emails you personally send (e.g. when you @mention a teammate). Your default signature is used automatically. The brand header/footer is applied separately by your admins.
      </div>
      <div>${rows}</div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-solid btn-sm" data-action="eb.newSig">Add signature</button>
        <span id="eb-sig-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;align-self:center"></span>
      </div>
    </div>`;
}

function ebSigRow(s) {
  const esc = window.escHtml;
  const defaultPill = s.is_default
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:3px;background:var(--green-lt);color:var(--green);font-size:10px;font-weight:600;text-transform:uppercase;font-family:'DM Mono',monospace;margin-left:8px">Default</span>`
    : '';
  const snippet = (s.body_text || '').replace(/\n/g, ' · ').slice(0, 90) || '(empty)';
  return `
    <div style="padding:10px 0;border-bottom:1px solid var(--rule);display:flex;align-items:center;gap:12px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;color:var(--ink);font-size:13px">${esc(s.name)}${defaultPill}</div>
        <div style="font-size:11px;color:var(--ink3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(snippet)}</div>
      </div>
      ${s.is_default ? '' : `<button class="btn btn-sm" data-action="eb.setDefaultSig" data-id="${window.escAttr(s.id)}">Set default</button>`}
      <button class="btn btn-sm" data-action="eb.editSig" data-id="${window.escAttr(s.id)}">Edit</button>
      <button class="btn btn-sm btn-danger" data-action="eb.deleteSig" data-id="${window.escAttr(s.id)}">Delete</button>
    </div>`;
}

function ebSigForm(s) {
  const escA = window.escAttr;
  const escH = window.escHtml;
  return `
    <div class="form-row">
      <label class="form-label">Signature name <span style="color:var(--ink3);font-weight:400;font-family:'DM Mono',monospace;font-size:11px">— for your reference only</span></label>
      <input class="form-input" id="eb-sig-name" value="${escA(s?.name || '')}" placeholder="e.g. Standard"/>
    </div>
    <div class="form-row">
      <label class="form-label">Signature</label>
      <textarea class="form-input" id="eb-sig-body" rows="4" maxlength="2000" placeholder="Jane Doe&#10;Senior Support Agent&#10;Acme" style="resize:vertical;font-family:inherit">${escH(s?.body_text || '')}</textarea>
      <div style="font-size:11px;color:var(--ink3);margin-top:4px">Plain text. Links are made clickable automatically.</div>
    </div>
    ${s ? '' : `
      <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--ink2);margin-top:6px">
        <input type="checkbox" id="eb-sig-default"/> Make this my default signature
      </label>`}`;
}

function ebReadSigForm() {
  return {
    name:       document.getElementById('eb-sig-name').value.trim(),
    body_text:  document.getElementById('eb-sig-body').value.trim() || null,
    is_default: document.getElementById('eb-sig-default')?.checked || false,
  };
}

function ebNewSig() {
  showModal('New signature', ebSigForm(null), async () => {
    const d = ebReadSigForm();
    if (!d.name) { alert('Signature name is required.'); return; }
    try {
      const res = await apiPost('/api/v1/email-branding/signatures', d);
      EB_SIGS.push(res.signature);
      if (res.signature.is_default) EB_SIGS.forEach((s) => { if (s.id !== res.signature.id) s.is_default = false; });
    } catch (err) { alert(`Couldn't create: ${err?.message || err}`); return; }
    closeModal(); renderPage('settings');
  }, 'Create');
}

function ebEditSig(id) {
  const s = EB_SIGS.find((x) => x.id === id);
  if (!s) return;
  showModal('Edit signature', ebSigForm(s), async () => {
    const d = ebReadSigForm();
    if (!d.name) { alert('Signature name is required.'); return; }
    try {
      const res = await apiPatch(`/api/v1/email-branding/signatures/${encodeURIComponent(id)}`, {
        name: d.name, body_text: d.body_text,
      });
      const i = EB_SIGS.findIndex((x) => x.id === id);
      if (i >= 0) EB_SIGS[i] = res.signature;
    } catch (err) { alert(`Couldn't save: ${err?.message || err}`); return; }
    closeModal(); renderPage('settings');
  }, 'Save');
}

async function ebSetDefaultSig(id) {
  try {
    await apiPost(`/api/v1/email-branding/signatures/${encodeURIComponent(id)}/default`);
    EB_SIGS.forEach((s) => { s.is_default = s.id === id; });
    renderPage('settings');
  } catch (err) { alert(`Couldn't set default: ${err?.message || err}`); }
}

async function ebDeleteSig(id) {
  if (!confirm('Delete this signature?')) return;
  try {
    await apiDelete(`/api/v1/email-branding/signatures/${encodeURIComponent(id)}`);
    EB_SIGS = EB_SIGS.filter((s) => s.id !== id);
    renderPage('settings');
  } catch (err) { alert(`Couldn't delete: ${err?.message || err}`); }
}

// ─── Action registration ───────────────────────────────────────────────────
registerActions({
  'eb.newTemplate':        () => ebNewTemplate(),
  'eb.editTemplate':       (ds) => ebEditTemplate(ds.id),
  'eb.setDefaultTemplate': (ds) => ebSetDefaultTemplate(ds.id),
  'eb.deleteTemplate':     (ds) => ebDeleteTemplate(ds.id),
  'eb.newSig':             () => ebNewSig(),
  'eb.editSig':            (ds) => ebEditSig(ds.id),
  'eb.setDefaultSig':      (ds) => ebSetDefaultSig(ds.id),
  'eb.deleteSig':          (ds) => ebDeleteSig(ds.id),
});
