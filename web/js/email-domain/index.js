// Sender domain settings — brand-owner self-serve custom sending domain
// (support@<their-domain>). Rendered as the admin-only "Sender domain" tab in
// Settings (web/js/settings/index.js imports settingsSenderDomain).
//
// Flow: admin adds their domain → the API provisions it at Postmark and
// returns the DNS records to publish (rendered as a copy-paste table) → while
// any domain is pending or degraded this module polls the check endpoint
// every 45s so verification flips live with zero clicks → on flip, a toast +
// the sender-identity block update. The daily cron sweep covers admins who
// never revisit the page.

import { apiGet, apiPost, apiDelete, getWorkspaceId } from '../core/api-client.js';
import { renderPage } from '../core/router.js';
import { registerActions, registerInputActions } from '../core/event-delegation.js';
import { showToast } from '../core/toast.js';
import { CURRENT_PAGE, SETTINGS_TAB } from '../core/state.js';

// ─── Module state ────────────────────────────────────────────────────────
let ED_DATA = null;       // { domains, sender_identity, inbound_address, postmark_configured }
let ED_LOADED = false;
let ED_ADD_INPUT = '';
let ED_ADD_PENDING = false;
let ED_ADD_ERROR = null;
let ED_ROW_PENDING = {};  // domainId -> true while a check/remove is in flight
let ED_ROW_MSG = {};      // domainId -> transient per-row status line
let ED_POLL_TIMER = null;
let ED_POLL_IDX = 0;      // round-robin cursor over non-verified domains
let ED_WS = null;         // workspace the cache belongs to (in-session switcher)

const POLL_MS = 45000;

// Re-render only while the user is still on Settings — an async response
// (45s poll, slow check) landing after they navigated away must not yank
// them back. renderPage('settings') NAVIGATES, it doesn't just repaint.
function edRerender() {
  if (CURRENT_PAGE === 'settings') renderPage('settings');
}

function edLoad() {
  apiGet('/api/v1/email-domains')
    .then((res) => { ED_DATA = res; edRerender(); })
    .catch((err) => { console.warn('[email-domain] load failed:', err); });
}

// ─── Zero-click verification poll ─────────────────────────────────────────
//
// Runs only while the Sender domain tab is up and a domain is pending or
// degraded. Stops itself when the tab changes, the panel is gone, or nothing
// needs watching. 429s (rate limit) are skipped silently — next tick retries.

function edEnsurePoll() {
  const needsWatch = (ED_DATA?.domains || []).some((d) => d.status !== 'verified');
  if (!needsWatch) { edStopPoll(); return; }
  if (ED_POLL_TIMER) return;
  ED_POLL_TIMER = setInterval(edPollTick, POLL_MS);
}

function edStopPoll() {
  if (ED_POLL_TIMER) { clearInterval(ED_POLL_TIMER); ED_POLL_TIMER = null; }
}

async function edPollTick() {
  if (SETTINGS_TAB !== 'sender-domain' || !document.getElementById('ed-panel')) { edStopPoll(); return; }
  // Round-robin, one check per tick: with several non-verified domains, a
  // fixed .find() would keep re-checking the first one and leave the rest
  // (and any stale dns_records snapshot they carry) unhealed until a manual
  // "Check now". One call per tick stays inside the check rate limit.
  const pending = (ED_DATA?.domains || []).filter((d) => d.status !== 'verified');
  if (!pending.length) { edStopPoll(); return; }
  const target = pending[ED_POLL_IDX++ % pending.length];
  try {
    const res = await apiPost(`/api/v1/email-domains/${target.id}/check`, {});
    edApplyCheck(target, res);
  } catch {
    // Rate-limited or transient — the next tick retries.
  }
}

function edApplyCheck(prev, res) {
  const idx = (ED_DATA?.domains || []).findIndex((d) => d.id === prev.id);
  if (idx === -1) return;
  ED_DATA.domains[idx] = res.domain;
  if (prev.status !== 'verified' && res.domain.status === 'verified') {
    showToast(`✓ ${res.domain.domain} verified — customer emails now send from support@${res.domain.domain}`, 'success', 7000);
    edLoad(); // refresh the sender-identity block too
  } else {
    edRerender();
  }
}

// ─── Render ───────────────────────────────────────────────────────────────

export function settingsSenderDomain() {
  // The in-session workspace switcher swaps workspaces without a reload —
  // drop a stale cache so workspace A's domains (and the poll against A's
  // domain ids) never render under workspace B.
  const ws = getWorkspaceId();
  if (ED_WS !== ws) {
    ED_WS = ws;
    ED_DATA = null; ED_LOADED = false;
    ED_ADD_INPUT = ''; ED_ADD_ERROR = null; ED_ADD_PENDING = false;
    ED_ROW_PENDING = {}; ED_ROW_MSG = {};
    ED_POLL_IDX = 0;
    edStopPoll();
  }
  if (!ED_LOADED) { ED_LOADED = true; edLoad(); }
  // (Re)arm the poll on every render — it self-guards against duplicates.
  setTimeout(edEnsurePoll, 0);

  if (!ED_DATA) {
    return `<div id="ed-panel" class="settings-section"><div style="color:var(--ink3);font-size:12px;padding:14px 0">Loading…</div></div>`;
  }

  const domains = ED_DATA.domains || [];
  const rows = domains.length === 0
    ? `<div style="color:var(--ink3);font-size:12px;padding:14px 0;text-align:center">No domain added yet — your emails send from the platform address.</div>`
    : domains.map(edDomainRow).join('');

  return `
    <div id="ed-panel">
      <div class="settings-section">
        <div class="settings-h">Sender identity</div>
        ${edIdentityBlock()}
      </div>
      <div class="settings-section">
        <div class="settings-h">Your domain</div>
        <div style="font-size:12px;color:var(--ink3);margin-bottom:12px">
          Send from <b>support@your-domain.com</b> instead of the platform address.
          Add your domain, publish the DNS records below with your DNS provider, and
          verification completes automatically — no further action needed.
        </div>
        ${edAddForm()}
        ${rows}
      </div>
      ${edReceivingBox()}
    </div>`;
}

function edIdentityBlock() {
  const esc = window.escHtml;
  const si = ED_DATA.sender_identity || { source: 'none' };
  const degraded = (ED_DATA.domains || []).find((d) => d.status === 'degraded');

  if (degraded) {
    return `
      <div style="padding:12px 16px;background:var(--red-lt);border-radius:var(--r2);font-size:13px">
        <span style="color:var(--red);font-weight:600">DNS records for ${esc(degraded.domain)} no longer verify</span>
        <span style="color:var(--ink2)"> — emails temporarily send from the platform address. Re-publish the records below; sending switches back automatically.</span>
      </div>`;
  }
  if (si.source === 'workspace') {
    return `
      <div style="padding:12px 16px;background:var(--green-lt);border-radius:var(--r2);font-size:13px">
        Customer emails send from <b style="font-family:'DM Mono',monospace">${esc(si.from_email)}</b>
        <span class="tag" style="margin-left:8px;color:var(--green);background:var(--green-lt);border-color:transparent">Verified</span>
      </div>`;
  }
  if (si.source === 'platform') {
    return `
      <div style="padding:12px 16px;background:var(--off2);border-radius:var(--r2);font-size:13px;color:var(--ink2)">
        Customer emails send from the platform address <b style="font-family:'DM Mono',monospace">${esc(si.from_email)}</b> — add your own domain below.
      </div>`;
  }
  return `
    <div style="padding:12px 16px;background:var(--amber-lt);border-radius:var(--r2);font-size:13px;color:var(--amber)">
      Outbound email isn't configured for this deployment yet.
    </div>`;
}

function edAddForm() {
  const escA = window.escAttr;
  if ((ED_DATA.domains || []).length > 0) return '';
  return `
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <input class="form-input" id="ed-add-input" placeholder="yourcasino.com" value="${escA(ED_ADD_INPUT)}"
             data-input-action="emailDomain.addInput" style="max-width:320px"/>
      <button class="btn btn-solid" data-action="emailDomain.add" ${ED_ADD_PENDING ? 'disabled' : ''}>
        ${ED_ADD_PENDING ? 'Adding…' : 'Add domain'}
      </button>
    </div>
    ${ED_ADD_ERROR ? `<div style="color:var(--red);font-size:12px;margin-bottom:10px">${window.escHtml(ED_ADD_ERROR)}</div>` : ''}
    ${ED_DATA.postmark_configured === false ? `<div style="color:var(--amber);font-size:12px;margin-bottom:10px">Domain provisioning isn't configured on this deployment (missing Postmark account token) — the domain can be added but DNS records won't be issued yet.</div>` : ''}`;
}

function edDomainRow(d) {
  const esc = window.escHtml;
  const escA = window.escAttr;
  const pill = d.status === 'verified'
    ? `<span class="tag" style="color:var(--green);background:var(--green-lt);border-color:transparent">Verified</span>`
    : d.status === 'degraded'
      ? `<span class="tag" style="color:var(--red);background:var(--red-lt);border-color:transparent">Attention needed</span>`
      : `<span class="tag" style="color:var(--amber);background:var(--amber-lt);border-color:transparent">Pending DNS</span>`;
  const busy = !!ED_ROW_PENDING[d.id];
  const msg = ED_ROW_MSG[d.id];

  return `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px">
        <b style="font-family:'DM Mono',monospace;font-size:14px">${esc(d.domain)}</b>
        ${pill}
        <span style="flex:1"></span>
        ${d.status !== 'verified' ? `<button class="btn btn-sm" data-action="emailDomain.check" data-id="${escA(d.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Check now'}</button>` : ''}
        <button class="btn btn-sm btn-danger" data-action="emailDomain.remove" data-id="${escA(d.id)}" data-domain="${escA(d.domain)}" ${busy ? 'disabled' : ''}>Remove</button>
      </div>
      ${msg ? `<div style="font-size:12px;color:var(--ink2);margin-top:8px">${esc(msg)}</div>` : ''}
      ${d.status !== 'verified' && d.dns_setup ? edDnsTable(d) : ''}
      ${d.status !== 'verified' && !d.dns_setup ? `<div style="font-size:12px;color:var(--ink3);margin-top:10px">DNS records aren't issued yet — use “Check now” to retry provisioning.</div>` : ''}
      ${d.status === 'pending' ? `<div style="font-size:11px;color:var(--ink3);margin-top:10px">Checking automatically — this page verifies the records for you once they're published (DNS changes can take a few minutes to appear).</div>` : ''}
    </div>`;
}

// dns_setup shape: { dkim, return_path, spf, dmarc } each { type, host, value, priority, why }.
function edDnsTable(d) {
  const recs = [
    ['dkim', 'DKIM'],
    ['return_path', 'Return-Path'],
    ['spf', 'SPF'],
    ['dmarc', 'DMARC'],
  ];
  return `
    <div style="margin-top:12px">
      <div style="font-size:12px;color:var(--ink2);margin-bottom:6px">Add these records with your DNS provider:</div>
      <table class="tbl" style="font-family:'DM Mono',monospace;font-size:11px">
        <thead><tr><th>Type</th><th>Host</th><th>Value</th><th></th></tr></thead>
        <tbody>
          ${recs.map(([key, label]) => edDnsRow(d, key, label)).join('')}
        </tbody>
      </table>
    </div>`;
}

function edDnsRow(d, key, label) {
  const esc = window.escHtml;
  const escA = window.escAttr;
  const rec = d.dns_setup?.[key];
  if (!rec) return '';
  const priColor = rec.priority === 'required' ? 'var(--red)' : 'var(--amber)';
  // A record can arrive with empty host/value (snapshot taken while Postmark
  // hadn't issued it, or a degraded payload). Blank cells with Copy buttons
  // that copy nothing read as broken — say what's happening instead.
  if (!rec.host || !rec.value) {
    return `
    <tr>
      <td>${esc(rec.type)} <span style="color:var(--ink3);font-size:10px">(${esc(label)})</span><br><span style="color:${priColor};font-size:10px">${esc(rec.priority)}</span></td>
      <td colspan="2" style="color:var(--ink3)">Not issued yet — “Check now” refreshes this record.</td>
      <td></td>
    </tr>`;
  }
  // Copy buttons read the value from module state via data-record/-field —
  // DKIM values are long and attribute-escaping them is fragile.
  const copyBtn = (field) =>
    `<button class="btn btn-sm" data-action="emailDomain.copy" data-id="${escA(d.id)}" data-record="${escA(key)}" data-field="${field}" title="Copy ${field}">Copy</button>`;
  return `
    <tr>
      <td>${esc(rec.type)} <span style="color:var(--ink3);font-size:10px">(${esc(label)})</span><br><span style="color:${priColor};font-size:10px">${esc(rec.priority)}</span></td>
      <td style="word-break:break-all">${esc(rec.host)} ${copyBtn('host')}</td>
      <td style="word-break:break-all">${esc(rec.value)} ${copyBtn('value')}</td>
      <td></td>
    </tr>`;
}

function edReceivingBox() {
  const esc = window.escHtml;
  const inbound = ED_DATA.inbound_address;
  if (!inbound) return '';
  return `
    <div class="settings-section">
      <div class="settings-h">Receiving replies</div>
      <div style="font-size:12px;color:var(--ink2);line-height:1.6">
        Replies to your emails already thread back into tickets automatically — nothing to set up.
        If you also want to publish <b>support@your-domain.com</b> as a public address (on your website,
        say), forward that mailbox to
        <b style="font-family:'DM Mono',monospace">${esc(inbound)}</b>
        <button class="btn btn-sm" data-action="emailDomain.copyInbound">Copy</button>
        and incoming mail becomes tickets here too.
      </div>
    </div>`;
}

// ─── Actions ──────────────────────────────────────────────────────────────

async function edAdd() {
  const domain = (document.getElementById('ed-add-input')?.value || ED_ADD_INPUT).trim().toLowerCase();
  if (!domain || !domain.includes('.')) {
    ED_ADD_ERROR = 'Enter a domain like yourcasino.com';
    renderPage('settings');
    return;
  }
  ED_ADD_PENDING = true; ED_ADD_ERROR = null;
  renderPage('settings');
  try {
    await apiPost('/api/v1/email-domains', { domain });
    ED_ADD_INPUT = '';
    edLoad();
  } catch (err) {
    ED_ADD_ERROR = err?.body?.error || err?.message || 'Could not add the domain.';
  } finally {
    ED_ADD_PENDING = false;
    edRerender();
  }
}

async function edCheck(id) {
  ED_ROW_PENDING[id] = true; ED_ROW_MSG[id] = null;
  renderPage('settings');
  try {
    const prev = (ED_DATA?.domains || []).find((d) => d.id === id);
    // manual: an explicit human check also clears a send-rejection degrade
    // (the automatic poll deliberately can't — see the API route).
    const res = await apiPost(`/api/v1/email-domains/${id}/check`, { manual: true });
    if (!res.fully_verified) {
      ED_ROW_MSG[id] = `DKIM ${res.dkim_verified ? '✓ verified' : '✗ not found yet'} · Return-Path ${res.return_path_verified ? '✓ verified' : '✗ not found yet'}`;
    }
    if (prev) edApplyCheck(prev, res);
  } catch (err) {
    ED_ROW_MSG[id] = err?.body?.error || 'Check failed — try again shortly.';
  } finally {
    delete ED_ROW_PENDING[id];
    edRerender();
  }
}

async function edRemove(id, domain) {
  if (!window.confirm(`Remove ${domain}? Emails will send from the platform address again.`)) return;
  ED_ROW_PENDING[id] = true;
  renderPage('settings');
  try {
    await apiDelete(`/api/v1/email-domains/${id}`);
    edLoad();
  } catch (err) {
    ED_ROW_MSG[id] = err?.body?.error || 'Remove failed — try again shortly.';
  } finally {
    delete ED_ROW_PENDING[id];
    edRerender();
  }
}

function edCopy(ds) {
  const rec = (ED_DATA?.domains || []).find((d) => d.id === ds.id)?.dns_setup?.[ds.record];
  const text = rec?.[ds.field];
  if (text) edClipboard(text);
}

function edClipboard(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => showToast('Copied to clipboard', 'success', 2000),
      () => showToast('Copy failed — select the text and use Ctrl+C', 'warn'),
    );
    return;
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(ok ? 'Copied to clipboard' : 'Copy failed — select the text and use Ctrl+C', ok ? 'success' : 'warn', 2000);
  } catch {
    showToast('Copy failed — select the text and use Ctrl+C', 'warn');
  }
}

registerActions({
  'emailDomain.add':         () => edAdd(),
  'emailDomain.check':       (ds) => edCheck(ds.id),
  'emailDomain.remove':      (ds) => edRemove(ds.id, ds.domain),
  'emailDomain.copy':        (ds) => edCopy(ds),
  'emailDomain.copyInbound': () => { if (ED_DATA?.inbound_address) edClipboard(ED_DATA.inbound_address); },
});

registerInputActions({
  // Keep module state in sync while typing so a poll-triggered re-render
  // mid-keystroke doesn't wipe the input (renders read value="${ED_ADD_INPUT}").
  'emailDomain.addInput': (ds, el) => { ED_ADD_INPUT = el.value; },
});
