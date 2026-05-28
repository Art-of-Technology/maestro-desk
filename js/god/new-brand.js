// New-brand form — single-page form that runs the full provisioning
// sequence: create brand → invite owner → add domain → show result.
//
// Each step is a separate API call rather than a single big POST, so:
//   - Partial success is recoverable (e.g. brand created but invite
//     failed — operator can retry invite without recreating the brand).
//   - The owner-invite + domain endpoints stay simple, do-one-thing routes.
//
// Result panel shows:
//   - Invite link (copy button) — operator pastes to brand owner via Slack/email
//   - DNS records (DKIM, Return-Path, SPF, DMARC) — operator shares with
//     brand owner to paste into their DNS provider
//
// Owner email + first domain are optional. The minimum viable brand is
// just a name + slug.

import { apiPost } from '../core/api-client.js';
import { registerActions, registerInputActions } from '../core/event-delegation.js';

// ─── State ────────────────────────────────────────────────────────────────

const FORM = {
  // Inputs
  name: '',
  slug: '',
  owner_email: '',
  domain: '',
  primary_color: '',
  support_email_display_name: '',
  ai_credits_usd: '',
  auto_reply_min_confidence: '',
  auto_reply_categories: '',
  // UI state
  submitting: false,
  error: null,
  // Result after successful submit
  result: null, // { brand, invite, domain, dns_setup }
};

// Hook for the parent god module to know when to go back to the list.
let _onClose = null;
export function setOnClose(fn) { _onClose = fn; }

// Triggers a re-render of the current main-area content. The god module
// owns the renderPage hook, but new-brand renders into the same main-area;
// keep this in sync with the god module's reRender pattern.
function reRender() {
  const main = document.getElementById('main-area');
  if (main && document.body.dataset.currentPage === 'god' && document.body.dataset.godView === 'new-brand') {
    main.innerHTML = renderNewBrand();
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────

export function renderNewBrand() {
  if (FORM.result) return renderResult();
  return renderForm();
}

export function resetForm() {
  FORM.name = '';
  FORM.slug = '';
  FORM.owner_email = '';
  FORM.domain = '';
  FORM.primary_color = '';
  FORM.support_email_display_name = '';
  FORM.ai_credits_usd = '';
  FORM.auto_reply_min_confidence = '';
  FORM.auto_reply_categories = '';
  FORM.submitting = false;
  FORM.error = null;
  FORM.result = null;
}

// ─── Form ─────────────────────────────────────────────────────────────────

function renderForm() {
  const disabled = FORM.submitting ? 'disabled' : '';
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Platform · New brand</div>
        <div class="tb-actions">
          <button class="btn btn-ghost" data-action="god.cancelNewBrand" ${disabled}>Cancel</button>
        </div>
      </div>
      <div class="page-scroll">
        ${FORM.error ? errorBanner(FORM.error) : ''}

        <div class="card" style="max-width:720px;margin:0 auto 16px">
          <div class="card-title">Required</div>
          <div class="form-row">
            <label class="form-label">Brand name</label>
            <input class="form-input" data-input-action="god.nb.name" value="${escAttr(FORM.name)}" placeholder="Acme Casino" ${disabled}/>
          </div>
          <div class="form-row">
            <label class="form-label">Slug</label>
            <input class="form-input" data-input-action="god.nb.slug" value="${escAttr(FORM.slug)}" placeholder="acmecasino" ${disabled}/>
            <div style="font-size:11px;color:var(--ink3);margin-top:4px">
              Lowercase letters / digits / hyphens; starts and ends alphanumeric. Used in URLs.
            </div>
          </div>
        </div>

        <div class="card" style="max-width:720px;margin:0 auto 16px">
          <div class="card-title">Owner (optional)</div>
          <div class="form-row">
            <label class="form-label">Owner email</label>
            <input class="form-input" data-input-action="god.nb.owner_email" value="${escAttr(FORM.owner_email)}" placeholder="owner@acmecasino.com" type="email" ${disabled}/>
            <div style="font-size:11px;color:var(--ink3);margin-top:4px">
              If provided, we generate a magic-link invite. The link appears on the result page for you to share.
            </div>
          </div>
        </div>

        <div class="card" style="max-width:720px;margin:0 auto 16px">
          <div class="card-title">First email domain (optional)</div>
          <div class="form-row">
            <label class="form-label">Domain</label>
            <input class="form-input" data-input-action="god.nb.domain" value="${escAttr(FORM.domain)}" placeholder="acmecasino.com" ${disabled}/>
            <div style="font-size:11px;color:var(--ink3);margin-top:4px">
              Just the apex domain — e.g. acmecasino.com, not support@acmecasino.com. The brand can add more later.
            </div>
          </div>
        </div>

        <div class="card" style="max-width:720px;margin:0 auto 16px">
          <div class="card-title">Branding (optional)</div>
          <div class="form-row">
            <label class="form-label">Primary colour</label>
            <input class="form-input" data-input-action="god.nb.primary_color" value="${escAttr(FORM.primary_color)}" placeholder="#0a84ff" ${disabled}/>
          </div>
          <div class="form-row">
            <label class="form-label">Sender display name</label>
            <input class="form-input" data-input-action="god.nb.support_email_display_name" value="${escAttr(FORM.support_email_display_name)}" placeholder="Acme Casino Support" ${disabled}/>
            <div style="font-size:11px;color:var(--ink3);margin-top:4px">
              Used as the From name on outbound mail. Defaults to the brand name.
            </div>
          </div>
        </div>

        <div class="card" style="max-width:720px;margin:0 auto 16px">
          <div class="card-title">AI (optional)</div>
          <div class="form-row">
            <label class="form-label">Starting AI credits (USD)</label>
            <input class="form-input" data-input-action="god.nb.ai_credits_usd" value="${escAttr(FORM.ai_credits_usd)}" placeholder="0" type="number" min="0" step="0.01" ${disabled}/>
            <div style="font-size:11px;color:var(--ink3);margin-top:4px">
              Stored as micro-USD. $5 ≈ 150–250 triages with prompt caching.
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">Auto-reply min confidence (0–100)</label>
            <input class="form-input" data-input-action="god.nb.auto_reply_min_confidence" value="${escAttr(FORM.auto_reply_min_confidence)}" placeholder="(blank = disabled)" type="number" min="0" max="100" ${disabled}/>
          </div>
          <div class="form-row">
            <label class="form-label">Auto-reply allowed categories</label>
            <input class="form-input" data-input-action="god.nb.auto_reply_categories" value="${escAttr(FORM.auto_reply_categories)}" placeholder="Account, Billing, Technical, Feature" ${disabled}/>
            <div style="font-size:11px;color:var(--ink3);margin-top:4px">
              Comma-separated. Categories not in this list are routed to a human even if confidence is high. Leave blank for none.
            </div>
          </div>
        </div>

        <div style="max-width:720px;margin:16px auto 32px;display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost" data-action="god.cancelNewBrand" ${disabled}>Cancel</button>
          <button class="btn btn-solid" data-action="god.submitNewBrand" ${disabled}>
            ${FORM.submitting ? 'Creating…' : 'Create brand'}
          </button>
        </div>
      </div>
    </div>`;
}

// ─── Result panel ─────────────────────────────────────────────────────────

function renderResult() {
  const { brand, invite, domain, dns_setup } = FORM.result;
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Platform · Brand created</div>
      </div>
      <div class="page-scroll">
        <div class="card" style="max-width:720px;margin:0 auto 16px;border-left:3px solid var(--green)">
          <div class="card-title">${escAttr(brand.name)} is live</div>
          <div style="font-size:13px;color:var(--ink2);line-height:1.6">
            Slug <code>${escAttr(brand.slug)}</code>. RLS-isolated. Default lookups + business hours seeded.
            ${invite || domain ? 'Follow the steps below to finish setup.' : ''}
          </div>
        </div>

        ${invite ? renderInvitePanel(invite) : ''}
        ${domain ? renderDomainPanel(domain, dns_setup) : ''}

        <div style="max-width:720px;margin:16px auto 32px;display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost" data-action="god.newBrandAnother">Create another</button>
          <button class="btn btn-solid" data-action="god.openCreatedBrand" data-id="${escAttr(brand.id)}">Open brand →</button>
        </div>
      </div>
    </div>`;
}

function renderInvitePanel(invite) {
  return `
    <div class="card" style="max-width:720px;margin:0 auto 16px">
      <div class="card-title">Share this invite link with ${escAttr(invite.email)}</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:8px">
        Paste it into Slack / email. The link signs them in and adds them as Admin of the brand.
      </div>
      ${invite.invite_link
        ? `<div style="display:flex;gap:6px;align-items:stretch">
            <input class="form-input" readonly value="${escAttr(invite.invite_link)}" id="invite-link-input" style="font-family:'DM Mono',monospace;font-size:11px"/>
            <button class="btn" data-action="god.copyInviteLink">Copy</button>
          </div>`
        : `<div style="font-size:12px;color:var(--amber)">No link returned by Supabase — check server logs.</div>`}
    </div>`;
}

function renderDomainPanel(domain, dns_setup) {
  if (!dns_setup) {
    return `
      <div class="card" style="max-width:720px;margin:0 auto 16px">
        <div class="card-title">Domain <code>${escAttr(domain.domain)}</code> registered locally</div>
        <div style="font-size:12px;color:var(--amber);line-height:1.6">
          POSTMARK_ACCOUNT_TOKEN isn't configured on the API, so no DKIM records were provisioned. Set the env var and hit
          <code>POST /api/v1/god/brands/${escAttr(domain.workspace_id || '')}/domains/${escAttr(domain.id)}/verify</code> to retry.
        </div>
      </div>`;
  }
  return `
    <div class="card" style="max-width:720px;margin:0 auto 16px">
      <div class="card-title">DNS records for <code>${escAttr(domain.domain)}</code></div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:12px;line-height:1.6">
        Send these to the brand owner. They paste into their DNS provider (Cloudflare, Route 53, etc.). After the records propagate
        (~5 min), open the brand and click "Verify" on the domain row.
      </div>
      <table class="tbl" style="font-family:'DM Mono',monospace;font-size:11px">
        <thead><tr><th>Type</th><th>Host</th><th>Value</th><th>Priority</th></tr></thead>
        <tbody>
          ${dnsRow('DKIM',         dns_setup.dkim)}
          ${dnsRow('Return-Path',  dns_setup.return_path)}
          ${dnsRow('SPF',          dns_setup.spf)}
          ${dnsRow('DMARC',        dns_setup.dmarc)}
        </tbody>
      </table>
    </div>`;
}

function dnsRow(label, rec) {
  const priColor = rec.priority === 'required' ? 'var(--red)' : 'var(--amber)';
  return `
    <tr>
      <td>${escAttr(rec.type)} <span style="color:var(--ink3);font-size:10px">(${escAttr(label)})</span></td>
      <td>${escAttr(rec.host)}</td>
      <td style="word-break:break-all">${escAttr(rec.value)}</td>
      <td><span style="color:${priColor}">${escAttr(rec.priority)}</span></td>
    </tr>
    <tr><td colspan="4" style="font-family:Inter,sans-serif;font-size:11px;color:var(--ink3);padding-top:0;padding-bottom:10px">${escAttr(rec.why)}</td></tr>`;
}

// ─── Submission ───────────────────────────────────────────────────────────

async function submit() {
  FORM.error = null;

  // Client-side validation. The server validates again with zod; we just
  // catch obvious mistakes early.
  if (!FORM.name.trim()) { FORM.error = 'Brand name is required.'; reRender(); return; }
  if (!FORM.slug.trim()) { FORM.error = 'Slug is required.'; reRender(); return; }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(FORM.slug.trim())) {
    FORM.error = 'Slug must be lowercase letters/digits/hyphens, starting and ending alphanumeric.';
    reRender();
    return;
  }
  if (FORM.slug.startsWith('__')) {
    FORM.error = 'Slugs starting with "__" are reserved.';
    reRender();
    return;
  }

  FORM.submitting = true;
  reRender();

  try {
    // 1. Create the brand.
    const createBody = {
      name: FORM.name.trim(),
      slug: FORM.slug.trim(),
    };
    if (FORM.primary_color.trim()) createBody.primary_color = FORM.primary_color.trim();
    if (FORM.support_email_display_name.trim()) createBody.support_email_display_name = FORM.support_email_display_name.trim();
    if (FORM.ai_credits_usd.trim()) {
      const usd = Number(FORM.ai_credits_usd);
      if (!Number.isFinite(usd) || usd < 0) throw new Error('AI credits must be a non-negative number');
      createBody.ai_credits_micro = Math.round(usd * 1_000_000);
    }
    if (FORM.auto_reply_min_confidence.trim()) {
      const c = Number(FORM.auto_reply_min_confidence);
      if (!Number.isInteger(c) || c < 0 || c > 100) throw new Error('Auto-reply confidence must be 0–100');
      createBody.auto_reply_min_confidence = c;
    }
    if (FORM.auto_reply_categories.trim()) {
      createBody.auto_reply_categories = FORM.auto_reply_categories
        .split(',').map((s) => s.trim()).filter(Boolean);
    }

    const createRes = await apiPost('/api/v1/god/brands', createBody);
    const brand = createRes.brand;

    // 2. Invite owner — best-effort. If it fails, the brand is still
    //    created; we report the partial failure on the result page.
    let invite = null;
    if (FORM.owner_email.trim()) {
      try {
        invite = await apiPost(`/api/v1/god/brands/${brand.id}/invite`, {
          email: FORM.owner_email.trim(),
        });
      } catch (err) {
        invite = { email: FORM.owner_email.trim(), invite_link: null, error: err.message };
      }
    }

    // 3. Add the first domain — best-effort.
    let domainRow = null;
    let dnsSetup = null;
    if (FORM.domain.trim()) {
      try {
        const dRes = await apiPost(`/api/v1/god/brands/${brand.id}/domains`, {
          domain: FORM.domain.trim().toLowerCase(),
        });
        domainRow = dRes.domain;
        dnsSetup = dRes.dns_setup;
      } catch (err) {
        domainRow = { domain: FORM.domain.trim(), workspace_id: brand.id, id: '', error: err.message };
      }
    }

    FORM.result = { brand, invite, domain: domainRow, dns_setup: dnsSetup };
  } catch (err) {
    FORM.error = err?.message || 'Brand creation failed.';
  } finally {
    FORM.submitting = false;
    reRender();
  }
}

// ─── Action wiring ────────────────────────────────────────────────────────

// Text-input bindings — one entry per field. Each handler writes to FORM
// without triggering a re-render (we only re-render on form-level events
// like submit, error, etc.) so the user doesn't lose input focus.
registerInputActions({
  'god.nb.name':                       (_ds, el) => { FORM.name = el.value; },
  'god.nb.slug':                       (_ds, el) => { FORM.slug = el.value; },
  'god.nb.owner_email':                (_ds, el) => { FORM.owner_email = el.value; },
  'god.nb.domain':                     (_ds, el) => { FORM.domain = el.value; },
  'god.nb.primary_color':              (_ds, el) => { FORM.primary_color = el.value; },
  'god.nb.support_email_display_name': (_ds, el) => { FORM.support_email_display_name = el.value; },
  'god.nb.ai_credits_usd':             (_ds, el) => { FORM.ai_credits_usd = el.value; },
  'god.nb.auto_reply_min_confidence':  (_ds, el) => { FORM.auto_reply_min_confidence = el.value; },
  'god.nb.auto_reply_categories':      (_ds, el) => { FORM.auto_reply_categories = el.value; },
});

registerActions({
  'god.submitNewBrand': () => submit(),
  'god.cancelNewBrand': () => {
    resetForm();
    _onClose?.();
  },
  'god.newBrandAnother': () => {
    resetForm();
    reRender();
  },
  'god.copyInviteLink': () => {
    const el = document.getElementById('invite-link-input');
    if (!el) return;
    el.select();
    document.execCommand('copy');
  },
  // god.openCreatedBrand is handled by god/index.js — see openBrand.
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function errorBanner(msg) {
  return `
    <div class="card" style="max-width:720px;margin:0 auto 16px;border-left:3px solid var(--red);padding:16px">
      <div style="color:var(--red);font-weight:600;margin-bottom:6px">Error</div>
      <div style="font-size:13px;color:var(--ink2)">${escAttr(msg)}</div>
    </div>`;
}

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
