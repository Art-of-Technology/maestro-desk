// ─── Integrations ────────────────────────────────────────────────────────────
// Brand-level connections to other apps, opened from the Configuration hub:
// the Slack connection, server-side outgoing webhooks and the Postmark
// suppression list. Everything here talks to /api/v1/integrations/*; reads are
// member-level and every write is gated by the admin.integrations permission.
// renderIntegrations is the router entry (page key `integrations`).
//
// External reaches (interim, via window): escHtml, escAttr — still in app.js.

import { can } from '../core/permissions.js';
import { CUSTOMERS } from '../core/data.js';
import { CURRENT_PAGE } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, getWorkspaceId, getJwt } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';
import { registerActions } from '../core/event-delegation.js';

// The retired browser-only Webhooks page kept its list in localStorage; drop
// the leftover so stale URLs and secrets don't linger in the browser.
try { localStorage.removeItem('webhooks'); } catch (e) { /* storage unavailable */ }

// In-memory snapshots of the workspace's integrations, loaded lazily
// when the page is first opened.
let SLACK_INTEGRATION = null;
let SLACK_LOADED = false;
let OUTGOING_WEBHOOKS = [];
let OUTGOING_WEBHOOKS_LOADED = false;
let LAST_REVEALED_SECRET = null;        // shown after a POST until the admin dismisses it
let SUPPRESSED_CUSTOMERS = [];
let SUPPRESSED_LOADED = false;
let SUPPRESSED_SCOPE = null;
const suppressionScope = () => `${getWorkspaceId() || ''}:${getJwt() || ''}`;
// Which brand/session the Slack and webhook snapshots below belong to. Every
// write handler notes the scope before its request and drops the response if
// the brand has changed by the time it lands, so an answer about one brand is
// never stored or shown under another.
let INTEGRATIONS_SCOPE = null;
const SLACK_EVENTS = [
  { k: 'ticket.created',   l: 'Ticket created' },
  { k: 'ticket.resolved',  l: 'Ticket resolved' },
  { k: 'ticket.escalated', l: 'Ticket escalated' },
  { k: 'priority.urgent',  l: 'Priority set to urgent' },
];
// Outgoing webhooks accept every Slack event plus the ones only the server's
// webhook dispatcher emits. Keep in sync with OUTGOING_EVENTS in
// api/src/routes/integrations.ts — an event missing here is silently dropped
// from a webhook the next time it is edited.
const WEBHOOK_EVENTS = [
  ...SLACK_EVENTS,
  { k: 'ticket.closed', l: 'Ticket closed without resolution' },
  { k: 'ticket.assigned', l: 'Ticket assignee changed' },
  { k: 'ticket.merged', l: 'Ticket merged into another' },
  { k: 'csat.submitted', l: 'CSAT response received' },
  // The server counts SLA time 24/7; the ticket screen may pause outside business hours.
  { k: 'sla.breach', l: 'SLA breached (counted around the clock)' },
];

// renderPage NAVIGATES rather than repainting, so a fetch that lands after the
// user has moved on must not pull them back to this page.
function repaint() {
  if (CURRENT_PAGE === 'integrations') renderPage('integrations');
}

export function renderIntegrations() {
  return `
    <div class="page">
      <div class="topbar"><div class="tb-title">Integrations</div></div>
      <div class="page-scroll">
        <div class="settings-panel" style="max-width:660px">${integrationsPanel()}</div>
      </div>
    </div>`;
}

// ─── Slack ──────────────────────────────────────────
function integrationsPanel() {
  // This module outlives a brand switch. Drop the previous brand's snapshots
  // so they are never shown, or saved, against the brand now open.
  const scope = suppressionScope();
  if (INTEGRATIONS_SCOPE !== scope) {
    INTEGRATIONS_SCOPE = scope;
    SLACK_INTEGRATION = null; SLACK_LOADED = false;
    OUTGOING_WEBHOOKS = []; OUTGOING_WEBHOOKS_LOADED = false;
    LAST_REVEALED_SECRET = null;
  }
  // Lazy load on first paint; trigger a re-render when the fetch lands. A
  // failed load clears the flag so the next paint tries again.
  if (!SLACK_LOADED) {
    SLACK_LOADED = true;
    apiGet('/api/v1/integrations/slack')
      .then((res) => { if (suppressionScope() !== scope) return; SLACK_INTEGRATION = res.integration; repaint(); })
      .catch(() => { if (suppressionScope() !== scope) return; SLACK_LOADED = false; console.warn('[integrations] slack load failed:'); });
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
        Get a message in Slack when something happens to a ticket. Each brand can connect to one Slack channel.
      </div>
      <div class="settings-desc" style="margin-bottom:18px">
        <strong>Set up Slack alerts</strong>
        <ol style="padding-left:20px;margin:8px 0;line-height:1.6">
          <li>Open <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" style="color:var(--purple)">your Slack apps (opens in a new tab)</a>. Create an app for your Slack workspace, or pick one you already have.</li>
          <li>In the app's settings, open <strong>Incoming Webhooks</strong> and switch on <strong>Activate Incoming Webhooks</strong>.</li>
          <li>Click <strong>Add New Webhook to Workspace</strong>, pick the channel for your alerts, and click <strong>Allow</strong>. To pick a private channel, you must be a member of it.</li>
          <li>Copy the link Slack gives you into <strong>Slack link (webhook URL)</strong> below. Leave <strong>Send to a different channel</strong> empty to use the channel you picked in Slack.</li>
          <li>Tick at least one box under <strong>Tell me when…</strong>, keep <strong>Alerts on</strong> switched on, and click <strong>Save</strong>. Leave the <strong>Reply from Slack</strong> boxes empty if you only want alerts.</li>
        </ol>
        Keep this link secret, like a password. Anyone who has it can post in your channel. After saving, click <strong>Send test alert</strong> to check it works.
        <a href="https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/" target="_blank" rel="noopener noreferrer" style="color:var(--purple)">Slack setup help (opens in a new tab)</a>.
      </div>
      <div class="form-row">
        <label class="form-label" for="slack-url">Slack link (webhook URL)</label>
        <input class="form-input" id="slack-url" type="password" placeholder="${slack?.has_webhook ? 'Leave empty to keep the saved link' : 'https://hooks.slack.com/services/...'}" autocomplete="off"/>
      </div>
      <div class="form-row">
        <label class="form-label">Send to a different channel (optional)</label>
        <input class="form-input" id="slack-channel" value="${window.escAttr(slack?.channel || '')}" placeholder="#support"/>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Leave this empty to use the channel you picked in Slack.</div>
      </div>
      <div class="form-row">
        <label class="form-label">Tell me when…</label>
        ${SLACK_EVENTS.map((e) => checkbox(e.k, e.l)).join('')}
      </div>
      <div class="form-row" style="display:flex;align-items:center;gap:8px">
        <label class="toggle"><input type="checkbox" id="slack-active" ${slack?.active !== false ? 'checked' : ''}/><span class="toggle-slider"></span></label>
        <span style="font-size:13px;color:var(--ink2)">Alerts on</span>
      </div>

      <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule)">
        <div style="font-size:12px;font-weight:600;color:var(--ink);margin-bottom:6px">Reply from Slack (optional)</div>
        <div style="font-size:11px;color:var(--ink3);margin-bottom:12px;line-height:1.5">
          Lets your team answer a ticket from inside Slack, and the reply is saved on the ticket. This needs extra setup in Slack; skip it if you only want alerts.
          <details style="margin-top:6px"><summary style="cursor:pointer">Setup details for developers</summary>
            The Slack app needs the <code style="font-family:'DM Mono',monospace;color:var(--ink2)">chat:write</code>, <code style="font-family:'DM Mono',monospace;color:var(--ink2)">users:read</code> and <code style="font-family:'DM Mono',monospace;color:var(--ink2)">users:read.email</code> scopes, and its Events API URL must point at <code style="font-family:'DM Mono',monospace;color:var(--ink2)">/api/v1/webhooks/slack/events</code>.
          </details>
        </div>
        ${slack?.has_bot_token ? `
          <div style="margin-bottom:10px;padding:8px 10px;background:var(--green-lt);border:1px solid var(--green);border-radius:var(--r);font-size:11px;color:var(--green);display:flex;gap:8px;align-items:center">
            <span style="font-weight:600">Reply from Slack is ready</span>
            <span style="font-family:'DM Mono',monospace;color:var(--ink2)">xoxb-...${window.escHtml(slack.bot_token_suffix || '')}</span>
          </div>` : ''}
        <div class="form-row">
          <label class="form-label">Bot token</label>
          <input class="form-input" id="slack-bot-token" type="password" placeholder="${slack?.has_bot_token ? 'Paste a new token to replace the saved one' : 'xoxb-...'}" autocomplete="off"/>
        </div>
        <div class="form-row">
          <label class="form-label">Signing secret</label>
          <input class="form-input" id="slack-signing-secret" type="password" placeholder="${slack?.has_signing_secret ? 'Paste a new secret to replace the saved one' : 'app signing secret'}" autocomplete="off"/>
        </div>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:14px">
        <button class="btn btn-solid btn-sm" data-action="integrations.saveSlack">Save</button>
        <button class="btn btn-sm" id="slack-test" data-action="integrations.testSlack" ${slack?.active && can('admin.integrations') ? '' : 'disabled'}>Send test alert</button>
        ${slack ? '<button class="btn btn-sm btn-danger" data-action="integrations.deleteSlack">Disconnect</button>' : ''}
        <span id="slack-msg" role="status" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace"></span>
      </div>
      <div class="settings-desc" style="margin-top:8px">The test uses your saved settings. Save your changes first and keep <strong>Alerts on</strong> switched on.</div>
    </div>
    ${settingsOutgoingWebhooksSection()}
    ${settingsSuppressionListSection()}`;
}

// ─── Outgoing webhooks ──────────────────────────────────────────────────
//
// Multiple webhooks per workspace, distinct from Slack
// (which is single-instance). List + Create + Delete are exposed in
// this slice. Secrets are surfaced once, at creation or rotation, via
// LAST_REVEALED_SECRET and stay on screen until the admin dismisses the
// banner, so a background re-render can't take the only copy away.

function settingsOutgoingWebhooksSection() {
  if (!OUTGOING_WEBHOOKS_LOADED) {
    OUTGOING_WEBHOOKS_LOADED = true;
    const scope = suppressionScope();
    apiGet('/api/v1/integrations/webhooks')
      .then((res) => { if (suppressionScope() !== scope) return; OUTGOING_WEBHOOKS = res.webhooks || []; repaint(); })
      .catch(() => { if (suppressionScope() !== scope) return; OUTGOING_WEBHOOKS_LOADED = false; console.warn('[integrations] webhooks load failed:'); });
  }
  const list = OUTGOING_WEBHOOKS;

  // One-time secret reveal: shown until dismissed (integrations.dismissSecret).
  const revealedBanner = LAST_REVEALED_SECRET ? `
    <div style="margin-bottom:14px;padding:12px 14px;background:var(--amber-lt);border:1px solid var(--amber);border-radius:var(--r);font-size:12px">
      <div style="font-weight:600;color:var(--amber);margin-bottom:6px">Copy this secret code now. We will not show it again.</div>
      <div style="font-family:'DM Mono',monospace;color:var(--ink);background:var(--off2);padding:8px 10px;border-radius:3px;word-break:break-all;user-select:all">${window.escHtml(LAST_REVEALED_SECRET)}</div>
      <div style="margin-top:6px;color:var(--ink3)">Paste it into the other app where it asks for a "signing secret".
        <details style="margin-top:4px"><summary style="cursor:pointer">For developers</summary>
          Compute HMAC-SHA256 with this secret over <code>v0:&lt;X-Maestro-Timestamp&gt;:&lt;raw-body&gt;</code> and compare the result to the <code>X-Maestro-Signature</code> header.
        </details>
      </div>
      <button class="btn btn-sm" style="margin-top:10px" data-action="integrations.dismissSecret">I've saved it</button>
    </div>` : '';

  const rows = list.length === 0 ? `
    <div style="color:var(--ink3);font-size:12px;padding:14px 0;text-align:center">No apps connected yet.</div>
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
        <button class="btn btn-sm" data-action="integrations.editWebhook" data-id="${window.escAttr(w.id)}">Edit</button>
        <button class="btn btn-sm" data-action="integrations.webhookDeliveries" data-id="${window.escAttr(w.id)}" data-name="${window.escAttr(w.name)}">Sent messages</button>
        <button class="btn btn-sm btn-danger" data-action="integrations.deleteWebhook" data-id="${window.escAttr(w.id)}">Remove</button>
      </div>`;
  }).join('');

  const eventCheckboxes = WEBHOOK_EVENTS.map((e) => `
    <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">
      <input type="checkbox" id="wh-evt-${e.k}" checked/>
      ${window.escHtml(e.l)}
    </label>`).join('');

  return `
    <div class="settings-section">
      <div class="settings-h">Send updates to other apps (webhooks)</div>
      <div class="settings-desc" style="margin-bottom:14px">
        Respovia can tell another app the moment something happens to a ticket, for example your CRM or a spreadsheet tool. You give us a web address, and we send a short message there each time. Each message is signed with a secret code so the other app can check it really came from Respovia. You will see the secret code once, right after you add the app.
      </div>
      ${revealedBanner}
      <div>${rows}</div>
      <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule)">
        <div style="font-size:12px;font-weight:600;color:var(--ink);margin-bottom:10px">Add an app</div>
        <div class="form-row">
          <label class="form-label">Name</label>
          <input class="form-input" id="wh-name" placeholder="e.g. CRM sync"/>
        </div>
        <div class="form-row">
          <label class="form-label">Web address to send to</label>
          <input class="form-input" id="wh-url" type="url" placeholder="https://example.com/respovia-updates"/>
        </div>
        <div class="form-row">
          <label class="form-label">Events</label>
          ${eventCheckboxes}
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-solid btn-sm" data-action="integrations.createWebhook">Add</button>
          <span id="wh-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace"></span>
        </div>
      </div>
    </div>`;
}

async function createOutgoingWebhook() {
  if (!can('admin.integrations')) return;
  const scope = suppressionScope();
  const name   = document.getElementById('wh-name').value.trim();
  const url    = document.getElementById('wh-url').value.trim();
  const events = WEBHOOK_EVENTS.filter((e) => document.getElementById(`wh-evt-${e.k}`)?.checked).map((e) => e.k);
  const msg = document.getElementById('wh-msg');
  if (!name) { msg.textContent = 'Name is required'; msg.style.color = 'var(--red)'; return; }
  if (!url)  { msg.textContent = 'The web address is required';  msg.style.color = 'var(--red)'; return; }
  if (events.length === 0) { msg.textContent = 'Pick at least one event'; msg.style.color = 'var(--red)'; return; }
  msg.textContent = 'Adding...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPost('/api/v1/integrations/webhooks', { name, url, events });
    if (suppressionScope() !== scope) {
      // The server has already created the webhook; say so rather than lose the secret silently.
      alert('The brand changed before the new secret code could be shown. Open the previous brand and get a new secret code for that app.');
      return;
    }
    LAST_REVEALED_SECRET = res.secret;
    // Re-fetch the list so the new row appears.
    const list = await apiGet('/api/v1/integrations/webhooks');
    if (suppressionScope() !== scope) return;   // brand changed while the request was in flight
    OUTGOING_WEBHOOKS = list.webhooks || [];
    repaint();
  } catch (err) {
    if (suppressionScope() !== scope) return;   // a failure about the previous brand is not shown under this one
    msg.textContent = err?.message || 'Could not add the app';
    msg.style.color = 'var(--red)';
  }
}

async function deleteOutgoingWebhook(id) {
  if (!can('admin.integrations')) return;
  const scope = suppressionScope();
  if (!confirm('Remove this app? Respovia will stop sending it updates straight away.')) return;
  try {
    await apiDelete(`/api/v1/integrations/webhooks/${encodeURIComponent(id)}`);
    if (suppressionScope() !== scope) return;   // brand changed while the request was in flight
    OUTGOING_WEBHOOKS = OUTGOING_WEBHOOKS.filter((w) => w.id !== id);
    repaint();
  } catch (err) {
    if (suppressionScope() !== scope) return;   // a failure about the previous brand is not shown under this one
    alert(`Couldn't remove: ${err?.message || err}`);
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
  const scope = suppressionScope();
  if (SUPPRESSED_SCOPE !== scope) {
    SUPPRESSED_SCOPE = scope;
    SUPPRESSED_CUSTOMERS = [];
    SUPPRESSED_LOADED = false;
  }
  if (!SUPPRESSED_LOADED) {
    SUPPRESSED_LOADED = true;
    apiGet('/api/v1/integrations/postmark/suppressed/contacts')
      .then((res) => {
        if (suppressionScope() !== scope) return;
        SUPPRESSED_CUSTOMERS = res.suppressed || [];
        repaint();
      })
      .catch((err) => {
        if (suppressionScope() !== scope) return;
        SUPPRESSED_LOADED = false;
        console.warn('[integrations] suppression load failed:');
      });
  }
  const list = SUPPRESSED_CUSTOMERS;
  const fmtTs = (ts) => ts ? new Date(ts).toISOString().slice(0, 10) : '—';
  const rows = list.length === 0 ? `
    <div style="color:var(--ink3);font-size:12px;padding:14px 0;text-align:center">No blocked addresses.</div>
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
        <button class="btn btn-sm" data-action="integrations.resetSuppressed" data-id="${window.escAttr(c.id)}" data-contact-id="${window.escAttr(c.contact_id || '')}">Unblock</button>
      </div>`;
  }).join('');

  return `
    <div class="settings-section">
      <div class="settings-h">Blocked email addresses</div>
      <div class="settings-desc" style="margin-bottom:14px">
        We stop emailing an address when our emails to it bounce back or the person marks them as spam. <strong>Unblock</strong> lets Respovia try again. Our email provider (Postmark) may still block it until it is cleared there too.
      </div>
      <div>${rows}</div>
    </div>`;
}

async function resetSuppressedCustomer(customerId, contactId) {
  if (!can('admin.integrations')) return;
  const scope = suppressionScope();
  if (!confirm('Unblock this address? Respovia will be able to email it again.')) return;
  try {
    const target = contactId ? `/contacts/${encodeURIComponent(contactId)}` : '';
    const result = await apiPost(`/api/v1/integrations/postmark/suppressed/${encodeURIComponent(customerId)}${target}/reset`);
    if (suppressionScope() !== scope) return;
    SUPPRESSED_CUSTOMERS = SUPPRESSED_CUSTOMERS.filter((c) => contactId ? c.contact_id !== contactId : c.id !== customerId);
    // Also clear the in-memory customer record so the badge disappears
    // on the customer detail without a full bootstrap reload.
    if (typeof CUSTOMERS !== 'undefined') {
      const cust = CUSTOMERS.find((c) => c._uuid === customerId);
      if (cust) {
        const address = cust.emails?.find((x) => contactId ? x.id === contactId : x.is_primary);
        if (address) {
          address.bounce_state = 'none';
          address.bounce_count = 0;
          address.bounce_last_at = null;
        }
        if (result.contact?.is_primary ?? !contactId) {
          cust.emailBounceState = 'none';
          cust.emailBounceCount = 0;
          cust.emailLastBounce  = null;
        }
      }
    }
    repaint();
  } catch (err) {
    alert(`Couldn't unblock: ${err?.message || err}`);
  }
}

// ─── Delivery log modal ─────────────────────────────────────────────────
//
// Opens a modal listing the 50 most recent delivery attempts for one
// webhook. Renders empty-then-load (showModal first with a "loading"
// stub, then swap the inner container's HTML when the fetch resolves)
// so the user gets immediate feedback. No re-fetch or live update —
// this is a snapshot view, the user closes + reopens for a refresh.

function showOutgoingWebhookDeliveries(id, name) {
  showModal(
    `Sent messages · ${name}`,
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
    return `<div style="color:var(--ink3);font-size:12px;text-align:center;padding:20px 0">No messages sent yet.</div>`;
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
          ? `<button class="btn btn-sm" data-action="integrations.retryDelivery" data-webhook-id="${window.escAttr(webhookId)}" data-delivery-id="${window.escAttr(d.id)}">Retry</button>`
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

async function retryWebhookDelivery(webhookId, deliveryId) {
  if (!can('admin.integrations')) return;
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

function editOutgoingWebhook(id) {
  if (!can('admin.integrations')) return;
  const w = OUTGOING_WEBHOOKS.find((x) => x.id === id);
  if (!w) return;
  const eventCheckboxes = WEBHOOK_EVENTS.map((e) => `
    <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">
      <input type="checkbox" id="we-evt-${e.k}" ${w.events.includes(e.k) ? 'checked' : ''}/>
      ${window.escHtml(e.l)}
    </label>`).join('');
  // onConfirm-with-callback is avoided here: showModal's .toString()
  // round-trip loses our module-scope imports (apiPatch in particular),
  // so the buttons are inlined into the body and routed through
  // data-action delegation (integrations.saveWebhookEdit / rotateSecret /
  // closeModal) instead.
  showModal(`Edit app · ${w.name}`,
    `<input type="hidden" id="we-id" value="${window.escAttr(w.id)}"/>
     <div class="form-row">
       <label class="form-label">Name</label>
       <input class="form-input" id="we-name" value="${window.escAttr(w.name)}"/>
     </div>
     <div class="form-row">
       <label class="form-label">Web address to send to</label>
       <input class="form-input" id="we-url" type="url" value="${window.escAttr(w.url)}"/>
     </div>
     <div class="form-row">
       <label class="form-label">Events</label>
       ${eventCheckboxes}
     </div>
     <div class="form-row" style="display:flex;align-items:center;gap:8px">
       <label class="toggle"><input type="checkbox" id="we-active" ${w.active ? 'checked' : ''}/><span class="toggle-slider"></span></label>
       <span style="font-size:13px;color:var(--ink2)">Sending on</span>
     </div>
     <div style="display:flex;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--rule)">
       <button class="btn" data-action="integrations.closeModal">Cancel</button>
       <button class="btn btn-solid" data-action="integrations.saveWebhookEdit">Save</button>
       <span id="we-msg" style="margin-left:auto;font-size:11px;font-family:'DM Mono',monospace;color:var(--ink3)"></span>
     </div>
     <div style="margin-top:18px;padding:12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r)">
       <div style="font-size:12px;font-weight:600;color:var(--ink);margin-bottom:6px">Get a new secret code</div>
       <div style="font-size:11px;color:var(--ink3);margin-bottom:10px;line-height:1.5">
         The old code stops working straight away. If the other app checks the code, it will reject messages until you paste the new one there.
       </div>
       <button class="btn btn-sm btn-danger" data-action="integrations.rotateSecret">Get a new code</button>
     </div>`,
    null, null, true,
  );
}

// Invoked from the edit modal's Save button via the integrations.saveWebhookEdit
// delegated action. Reads the form by id rather than closing over the webhook
// record (see modal.js comment).
async function saveOutgoingWebhookEdit() {
  if (!can('admin.integrations')) return;
  const scope = suppressionScope();
  const id     = document.getElementById('we-id').value;
  const name   = document.getElementById('we-name').value.trim();
  const url    = document.getElementById('we-url').value.trim();
  const events = WEBHOOK_EVENTS.filter((e) => document.getElementById(`we-evt-${e.k}`)?.checked).map((e) => e.k);
  const active = document.getElementById('we-active').checked;
  const msg = document.getElementById('we-msg');
  if (!name) { msg.textContent = 'Name is required'; msg.style.color = 'var(--red)'; return; }
  if (!url)  { msg.textContent = 'The web address is required';  msg.style.color = 'var(--red)'; return; }
  if (events.length === 0) { msg.textContent = 'Pick at least one event'; msg.style.color = 'var(--red)'; return; }
  try {
    const res = await apiPatch(`/api/v1/integrations/webhooks/${encodeURIComponent(id)}`, { name, url, events, active });
    if (suppressionScope() !== scope) return;   // brand changed while the request was in flight
    // Replace the row in module state so the panel re-renders with
    // the new values without a full refetch.
    OUTGOING_WEBHOOKS = OUTGOING_WEBHOOKS.map((w) => w.id === id ? { ...w, ...res.webhook } : w);
    closeModal();
    repaint();
  } catch (err) {
    if (suppressionScope() !== scope) return;   // a failure about the previous brand is not shown under this one
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

async function rotateOutgoingWebhookSecret() {
  if (!can('admin.integrations')) return;
  const scope = suppressionScope();
  const id = document.getElementById('we-id').value;
  if (!confirm('Get a new secret code? The old code will stop working straight away.')) return;
  const msg = document.getElementById('we-msg');
  msg.textContent = 'Getting a new code...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPatch(`/api/v1/integrations/webhooks/${encodeURIComponent(id)}`, { rotate_secret: true });
    if (suppressionScope() !== scope) {
      // The server has already replaced the secret; say so rather than lose the secret silently.
      alert('The brand changed before the new secret code could be shown. Open the previous brand and get a new secret code for that app.');
      return;
    }
    // Surface the new secret via the same one-shot banner used by
    // create — close the modal so the user can see it on the panel.
    LAST_REVEALED_SECRET = res.secret;
    OUTGOING_WEBHOOKS = OUTGOING_WEBHOOKS.map((w) => w.id === id ? { ...w, ...res.webhook } : w);
    closeModal();
    repaint();
  } catch (err) {
    if (suppressionScope() !== scope) return;   // a failure about the previous brand is not shown under this one
    msg.textContent = err?.message || 'Could not get a new code';
    msg.style.color = 'var(--red)';
  }
}

async function saveSlackIntegration() {
  if (!can('admin.integrations')) return;
  const scope = suppressionScope();
  const url           = document.getElementById('slack-url').value.trim();
  const channel       = document.getElementById('slack-channel').value.trim();
  const active        = document.getElementById('slack-active').checked;
  const events        = SLACK_EVENTS.filter((e) => document.getElementById(`slack-evt-${e.k}`)?.checked).map((e) => e.k);
  const botToken      = document.getElementById('slack-bot-token')?.value.trim() || '';
  const signingSecret = document.getElementById('slack-signing-secret')?.value.trim() || '';
  const msg = document.getElementById('slack-msg');
  if (!url && !SLACK_INTEGRATION?.has_webhook) { msg.textContent = 'The Slack link is required'; msg.style.color = 'var(--red)'; return; }
  if (events.length === 0) { msg.textContent = 'Tick at least one box'; msg.style.color = 'var(--red)'; return; }
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    // Only send bot_token / signing_secret when the user actually
    // typed something — sending undefined leaves the server-side value
    // alone, which is what we want for "save settings without
    // rotating credentials".
    const body = {
      channel:     channel || null,
      active,
      events,
    };
    if (url)           body.webhook_url    = url;
    if (botToken)      body.bot_token      = botToken;
    if (signingSecret) body.signing_secret = signingSecret;
    await apiPut('/api/v1/integrations/slack', body);
    if (suppressionScope() !== scope) return;   // brand changed while the request was in flight
    // The form may be gone if the admin navigated away mid-save; the saved
    // state must still be refreshed, so never let a missing field throw.
    const clear = (id) => { const el = document.getElementById(id); if (el) el.value = ''; };
    clear('slack-url');
    const res = await apiGet('/api/v1/integrations/slack');
    if (suppressionScope() !== scope) return;   // brand changed while the request was in flight
    SLACK_INTEGRATION = res.integration;
    clear('slack-bot-token');
    clear('slack-signing-secret');
    msg.textContent = 'Saved'; msg.style.color = 'var(--green)';
    repaint();
  } catch (err) {
    if (suppressionScope() !== scope) return;   // a failure about the previous brand is not shown under this one
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

async function testSlackIntegration() {
  if (!can('admin.integrations')) return;
  const button = document.getElementById('slack-test');
  if (button.disabled) return;
  const msg = document.getElementById('slack-msg');
  button.disabled = true;
  msg.textContent = 'Sending test alert...';
  msg.style.color = 'var(--ink3)';
  try {
    await apiPost('/api/v1/integrations/slack/test', {});
    msg.textContent = 'Slack accepted the test alert. Check your channel.';
    msg.style.color = 'var(--green)';
  } catch (err) {
    msg.textContent = err?.message || 'Delivery could not be confirmed. Check Slack before trying again.';
    msg.style.color = 'var(--red)';
  } finally {
    button.disabled = false;
  }
}

async function deleteSlackIntegration() {
  if (!can('admin.integrations')) return;
  const scope = suppressionScope();
  if (!confirm('Disconnect Slack? You will stop getting alerts until you connect it again.')) return;
  try {
    await apiDelete('/api/v1/integrations/slack');
    if (suppressionScope() !== scope) return;   // brand changed while the request was in flight
    SLACK_INTEGRATION = null;
    repaint();
  } catch (err) {
    if (suppressionScope() !== scope) return;   // a failure about the previous brand is not shown under this one
    alert(`Couldn't disconnect: ${err?.message || err}`);
  }
}

// ─── Delegated actions ──────────────────────────────────────────────────────
registerActions({
  // slack
  'integrations.saveSlack':         () => saveSlackIntegration(),
  'integrations.testSlack':         () => testSlackIntegration(),
  'integrations.deleteSlack':       () => deleteSlackIntegration(),
  // outgoing webhooks
  'integrations.createWebhook':     () => createOutgoingWebhook(),
  'integrations.editWebhook':       (ds) => editOutgoingWebhook(ds.id),
  'integrations.deleteWebhook':     (ds) => deleteOutgoingWebhook(ds.id),
  'integrations.webhookDeliveries': (ds) => showOutgoingWebhookDeliveries(ds.id, ds.name),
  'integrations.retryDelivery':     (ds) => retryWebhookDelivery(ds.webhookId, ds.deliveryId),
  'integrations.saveWebhookEdit':   () => saveOutgoingWebhookEdit(),
  'integrations.rotateSecret':      () => rotateOutgoingWebhookSecret(),
  'integrations.closeModal':        () => closeModal(),
  'integrations.dismissSecret':     () => { LAST_REVEALED_SECRET = null; repaint(); },
  // suppression list
  'integrations.resetSuppressed':   (ds) => resetSuppressedCustomer(ds.id, ds.contactId),
});
