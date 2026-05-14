// ─── Webhooks ───────────────────────────────────────────────────────────────
// Outbound HTTP notifications fired on key ticket events. Each webhook
// targets a URL, subscribes to one or more events, and keeps a short delivery
// log so admins can debug failures. Browser CORS will block most cross-origin
// POSTs; we record whatever happens (success, HTTP error, CORS failure) so the
// log surfaces the cause. For integrators we recommend a relay (workflow tool
// or serverless function) that bridges browser → real endpoint.
//
// External reaches (interim, via window): isAdmin, showModal, closeModal,
// renderPage, escHtml, escAttr — all still in app.js.
//
// CURRENT_PAGE comes from state.js; CUSTOMERS from data.js (both in global
// lex env, so direct refs work from the module).

const WEBHOOK_EVENT_TYPES = [
  { v:'ticket.created',   l:'Ticket created' },
  { v:'ticket.resolved',  l:'Ticket resolved' },
  { v:'ticket.escalated', l:'Ticket escalated' },
  { v:'ticket.assigned',  l:'Ticket assignee changed' },
  { v:'ticket.merged',    l:'Ticket merged into another' },
  { v:'sla.breach',       l:'SLA breached' },
  { v:'csat.submitted',   l:'CSAT response received' },
];
const WEBHOOK_DELIVERY_CAP = 20;

const WEBHOOKS = (() => {
  try { return JSON.parse(localStorage.getItem('webhooks') || 'null') || seedWebhooks(); }
  catch (e) { return seedWebhooks(); }
})();
function seedWebhooks() {
  // One disabled example so an admin can see the shape immediately. Points
  // at a clearly-fake URL — admins must edit before enabling, and the
  // disabled state makes it obvious nothing is firing on first open.
  return [{
    id: 'WH-001',
    name: 'Example — edit the URL before enabling',
    url: 'https://your-relay.example.com/webhook',
    secret: '',
    events: ['ticket.resolved', 'sla.breach'],
    active: false,
    deliveries: [],
    createdAt: '2026-05-01',
  }];
}
function saveWebhooks() {
  try { localStorage.setItem('webhooks', JSON.stringify(WEBHOOKS)); }
  catch (e) { console.warn('[webhooks] persist failed', e); }
}
function whNextId() {
  const max = Math.max(0, ...WEBHOOKS.map(w => parseInt((w.id||'').split('-')[1] || '0', 10)));
  return 'WH-' + String(max + 1).padStart(3, '0');
}

// HMAC-SHA256 signs the body with the webhook's shared secret. Lets the
// receiver verify the request came from us and hasn't been tampered with.
// SubtleCrypto is part of the Web Crypto API and is widely supported.
async function hmacSha256Hex(secret, body) {
  if (!secret || !crypto?.subtle) return null;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return null; }
}

// POST a single hook. Splitting this out from the broadcast loop lets the
// test-fire button target one hook without mutating the WEBHOOKS array.
async function deliverWebhook(h, event, body) {
  const started = Date.now();
  let entry;
  // Defensive URL check: form validation rejects non-http(s) on save, but
  // re-check here so a tampered localStorage entry can't smuggle a
  // javascript:/file:/data: target into fetch.
  if (typeof h.url !== 'string' || !/^https?:\/\//i.test(h.url.trim())) {
    entry = { ts: new Date().toISOString(), event, status: 0, ok: false, durationMs: 0, error: 'Invalid URL (must start with http:// or https://)' };
  } else {
    const headers = { 'Content-Type': 'application/json', 'X-Webhook-Event': event };
    if (h.secret) {
      const sig = await hmacSha256Hex(h.secret, body);
      if (sig) headers['X-Webhook-Signature'] = 'sha256=' + sig;
    }
    try {
      const res = await fetch(h.url, { method: 'POST', headers, body, mode: 'cors' });
      entry = { ts: new Date().toISOString(), event, status: res.status, ok: res.ok, durationMs: Date.now() - started };
    } catch (e) {
      entry = { ts: new Date().toISOString(), event, status: 0, ok: false, durationMs: Date.now() - started, error: e?.message || 'fetch failed (likely CORS)' };
    }
  }
  h.deliveries = h.deliveries || [];
  h.deliveries.unshift(entry);
  if (h.deliveries.length > WEBHOOK_DELIVERY_CAP) h.deliveries.length = WEBHOOK_DELIVERY_CAP;
  h.lastFiredAt = entry.ts;
  h.lastStatus = entry.ok ? 'success' : 'failure';
  return entry;
}

// Fire all webhooks subscribed to `event`. Deliveries run in parallel via
// Promise.all so a slow endpoint doesn't block the others.
export async function fireWebhook(event, payload) {
  if (!WEBHOOKS.length) return;
  const hooks = WEBHOOKS.filter(h => h.active && (h.events || []).includes(event));
  if (!hooks.length) return;
  const body = JSON.stringify({ event, at: new Date().toISOString(), payload });
  await Promise.all(hooks.map(h => deliverWebhook(h, event, body)));
  saveWebhooks();
  if (CURRENT_PAGE === 'webhooks') window.renderPage('webhooks');
}

// Helper to build a compact ticket payload — keep noise out of webhook POSTs.
export function ticketPayload(t) {
  if (!t) return null;
  const cust = CUSTOMERS.find(c => c.id === t.customerId);
  return {
    id: t.id, subject: t.subject, status: t.status, priority: t.priority, category: t.category,
    agent: t.agent || null, sla: t.sla || null,
    customer: cust ? { id: cust.id, name: `${cust.first} ${cust.last}`, email: cust.email, brand: cust.brand, vip: cust.vip } : { id: t.customerId },
    created: t.created, updated: t.updated,
  };
}

export function whNew() {
  if (!window.isAdmin()) return;
  whFormModal(null);
}
export function whEdit(id) {
  if (!window.isAdmin()) return;
  const h = WEBHOOKS.find(x => x.id === id);
  if (h) whFormModal(h);
}
// Common integration targets — pre-fill name + URL pattern + sensible event
// subscriptions. The "note" surfaces during template selection so admins know
// what shape the relay/receiver should expect. Payload shape is always the
// app's native {event, at, payload}; transforming for chat targets is left to
// the relay (Zapier, n8n, serverless function, etc.) which makes templates
// composable rather than locked-in.
const WEBHOOK_TEMPLATES = [
  { id:'slack', name:'Slack — incoming webhook',
    url:'https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXX',
    events:['ticket.escalated','sla.breach'],
    note:'Slack incoming webhooks expect {text}. Route via a relay (Zapier / Workflow) that formats the native payload into Slack message text, or use a Slack workflow accepting raw JSON.' },
  { id:'teams', name:'Microsoft Teams — incoming webhook',
    url:'https://outlook.office.com/webhook/00000000-0000/IncomingWebhook/...',
    events:['ticket.escalated','sla.breach'],
    note:'Teams Office 365 / Power Automate webhooks expect MessageCard or Adaptive Card JSON. Use a Logic Apps step to transform first.' },
  { id:'discord', name:'Discord — channel webhook',
    url:'https://discord.com/api/webhooks/0000000000/XXXXXXXX',
    events:['ticket.escalated','sla.breach','ticket.resolved'],
    note:'Discord webhooks expect {content} or {embeds}. Route via a relay or a Discord-side webhook handler that maps event to message.' },
  { id:'pagerduty', name:'PagerDuty — Events API v2',
    url:'https://events.pagerduty.com/v2/enqueue',
    events:['sla.breach','ticket.escalated'],
    note:'PagerDuty Events API expects {routing_key, event_action, payload}. Put the routing key in the secret field and rebuild the payload in a relay.' },
  { id:'opsgenie', name:'Opsgenie — alert API',
    url:'https://api.opsgenie.com/v2/alerts',
    events:['sla.breach','ticket.escalated'],
    note:'Opsgenie expects GenieKey auth in the Authorization header and a {message, alias, description} body — transform via relay.' },
  { id:'zapier', name:'Zapier — catch hook',
    url:'https://hooks.zapier.com/hooks/catch/0000000/abcdef/',
    events:['ticket.created','ticket.resolved','ticket.escalated','sla.breach','csat.submitted'],
    note:'Zapier catch hooks accept any JSON, so the native payload works as-is. Map fields in a downstream Zap step.' },
  { id:'make', name:'Make.com — custom webhook',
    url:'https://hook.eu1.make.com/abcdefghijklmnopqrstuvwxyz0123',
    events:['ticket.created','ticket.resolved','ticket.escalated','sla.breach','csat.submitted'],
    note:'Make custom webhooks accept arbitrary JSON. The native payload works as-is.' },
  { id:'n8n', name:'n8n — Webhook node',
    url:'https://n8n.example.com/webhook/maestro-desk',
    events:['ticket.created','ticket.resolved','ticket.escalated','sla.breach','csat.submitted'],
    note:'n8n Webhook nodes accept arbitrary JSON and you build the downstream flow visually.' },
  { id:'jira', name:'Jira Cloud — create issue (REST)',
    url:'https://your-domain.atlassian.net/rest/api/3/issue',
    events:['ticket.escalated'],
    note:'Direct Jira API requires Basic auth — supply the base64 of email:token in the Authorization header (use a relay; the browser can\'t set Authorization on cross-origin requests).' },
  { id:'linear', name:'Linear — issue create (relay)',
    url:'https://your-relay.example.com/linear-create',
    events:['ticket.escalated'],
    note:'Linear\'s API uses GraphQL + bearer auth. Route via a relay that translates the native payload into a createIssue mutation.' },
  { id:'github', name:'GitHub — repository_dispatch',
    url:'https://api.github.com/repos/OWNER/REPO/dispatches',
    events:['ticket.created','ticket.escalated'],
    note:'GitHub repository_dispatch requires a PAT in the Authorization header. Use a relay to add the auth header and reshape into {event_type, client_payload}.' },
  { id:'webhook-site', name:'webhook.site — quick test target',
    url:'https://webhook.site/your-uuid-here',
    events:['ticket.created','ticket.resolved','ticket.escalated','sla.breach','csat.submitted'],
    note:'Free request inspector for quickly verifying delivery shape. Replace the UUID with your test endpoint.' },
];

export function whApplyTemplate(idOrNull) {
  if (!idOrNull) return;
  const tpl = WEBHOOK_TEMPLATES.find(t => t.id === idOrNull);
  if (!tpl) return;
  const nameEl = document.getElementById('wh-name');
  const urlEl  = document.getElementById('wh-url');
  if (nameEl) nameEl.value = tpl.name;
  if (urlEl)  urlEl.value  = tpl.url;
  document.querySelectorAll('[data-wh-event]').forEach(el => { el.checked = tpl.events.includes(el.dataset.whEvent); });
  const noteEl = document.getElementById('wh-template-note');
  if (noteEl) {
    noteEl.style.display = 'block';
    noteEl.textContent = tpl.note;
  }
}

function whFormModal(h) {
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const events = WEBHOOK_EVENT_TYPES;
  const subscribed = (h?.events) || [];
  const templateOptions = WEBHOOK_TEMPLATES.map(t => `<option value="${window.escAttr(t.id)}">${window.escHtml(t.name)}</option>`).join('');
  window.showModal(h ? `Edit webhook · ${h.id}` : 'New webhook', `
    ${!h ? `<div class="form-row">
      <label class="form-label">Start from a template (optional)</label>
      <select class="form-input" id="wh-template" onchange="whApplyTemplate(this.value)">
        <option value="">— Blank webhook —</option>
        ${templateOptions}
      </select>
      <div id="wh-template-note" style="display:none;font-size:11px;color:var(--ink3);margin-top:6px;padding:8px 10px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);line-height:1.5"></div>
    </div>` : ''}
    <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="wh-name" value="${esc(h?.name)}" placeholder="e.g. Slack relay"/></div>
    <div class="form-row"><label class="form-label">URL</label><input class="form-input" id="wh-url" type="url" value="${esc(h?.url)}" placeholder="https://hooks.example.com/abc"/></div>
    <div class="form-row"><label class="form-label">Secret (optional)</label><input class="form-input" id="wh-secret" type="password" value="${esc(h?.secret)}" placeholder="Used as the HMAC-SHA256 signing key"/></div>
    <div class="form-row"><label class="form-label">Events</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;border:1px solid var(--rule);border-radius:var(--r);padding:8px">
        ${events.map(e => `<label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--ink2);cursor:pointer"><input type="checkbox" data-wh-event="${e.v}" ${subscribed.includes(e.v)?'checked':''}/> ${window.escHtml(e.l)}</label>`).join('')}
      </div>
    </div>
  `, () => {
    const name = document.getElementById('wh-name').value.trim();
    const url = document.getElementById('wh-url').value.trim();
    if (!name) { alert('Name is required.'); return; }
    if (!/^https?:\/\//i.test(url)) { alert('URL must start with http:// or https://'); return; }
    const events = [...document.querySelectorAll('[data-wh-event]:checked')].map(el => el.dataset.whEvent);
    if (!events.length) { alert('Subscribe to at least one event.'); return; }
    const secret = document.getElementById('wh-secret').value;
    if (h) {
      h.name = name; h.url = url; h.secret = secret; h.events = events;
    } else {
      WEBHOOKS.unshift({ id: whNextId(), name, url, secret, events, active: true, deliveries: [], createdAt: new Date().toISOString().slice(0,10) });
    }
    saveWebhooks();
    window.closeModal(); window.renderPage('webhooks');
  }, h ? 'Save' : 'Create');
}
export function whToggle(id, active) {
  if (!window.isAdmin()) return;
  const h = WEBHOOKS.find(x => x.id === id);
  if (h) { h.active = !!active; saveWebhooks(); }
}
export function whDelete(id) {
  if (!window.isAdmin()) return;
  const h = WEBHOOKS.find(x => x.id === id); if (!h) return;
  window.showModal('Delete webhook', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${window.escHtml(h.name)}</strong>? Past deliveries will be lost.</div>`, () => {
    const i = WEBHOOKS.findIndex(x => x.id === id);
    if (i >= 0) WEBHOOKS.splice(i, 1);
    saveWebhooks();
    window.closeModal(); window.renderPage('webhooks');
  }, 'Delete');
}
export async function whTestFire(id) {
  const h = WEBHOOKS.find(x => x.id === id);
  if (!h) return;
  // Test-fire bypasses the active/subscribed filters and goes through the
  // single-hook deliver helper directly. Avoids the race that would happen
  // if a real event landed while we mutated the shared WEBHOOKS array.
  const event = (h.events && h.events[0]) || 'ticket.created';
  const samplePayload = { test: true, message: 'Test delivery from Maestro Desk webhooks', timestamp: new Date().toISOString() };
  const body = JSON.stringify({ event, at: new Date().toISOString(), payload: samplePayload });
  await deliverWebhook(h, event, body);
  saveWebhooks();
  window.renderPage('webhooks');
}

export function renderWebhooks() {
  const admin = window.isAdmin();
  const total = WEBHOOKS.length;
  const activeN = WEBHOOKS.filter(h => h.active).length;
  const recentDeliveries = WEBHOOKS.flatMap(h => (h.deliveries || []).map(d => ({...d, hook: h.name, hookId: h.id})))
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, 8);
  const failingN = WEBHOOKS.filter(h => h.lastStatus === 'failure').length;

  const rows = WEBHOOKS.map(h => `
    <tr>
      <td class="bold">${window.escHtml(h.id)}</td>
      <td><strong style="color:var(--ink)">${window.escHtml(h.name)}</strong></td>
      <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink2);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(h.url)}</td>
      <td style="font-size:11px;color:var(--ink2)">${(h.events||[]).map(e => `<span class="tag tag-neutral" style="font-size:9px;margin:1px 2px">${window.escHtml(e)}</span>`).join('')}</td>
      <td style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml((h.lastFiredAt || '').slice(0,16).replace('T',' ') || '—')}</td>
      <td>${h.lastStatus === 'success' ? '<span style="color:var(--green);font-weight:500">●</span> ok' : h.lastStatus === 'failure' ? '<span style="color:var(--red);font-weight:500">●</span> failed' : '<span style="color:var(--ink3)">—</span>'}</td>
      <td style="text-align:center">
        <label class="toggle">
          <input type="checkbox" ${h.active?'checked':''} ${admin?'':'disabled'} onchange="whToggle('${window.escAttr(h.id)}',this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </td>
      ${admin ? `<td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" onclick="whTestFire('${window.escAttr(h.id)}')">Test</button>
        <button class="btn btn-sm" onclick="whEdit('${window.escAttr(h.id)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="whDelete('${window.escAttr(h.id)}')">Delete</button>
      </td>` : ''}
    </tr>`).join('');

  const deliveryRows = recentDeliveries.map(d => `
    <div style="display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--rule);border-radius:var(--r);background:var(--off2);margin-bottom:5px">
      <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);width:140px;flex-shrink:0">${window.escHtml((d.ts || '').slice(0,16).replace('T',' '))}</span>
      <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink2);flex-shrink:0">${window.escHtml(d.hookId)}</span>
      <span class="tag tag-neutral" style="font-size:9px;flex-shrink:0">${window.escHtml(d.event)}</span>
      <span style="flex:1;font-size:11px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(d.hook)}${d.error ? ' · ' + window.escHtml(d.error) : ''}</span>
      <span style="font-family:'DM Mono',monospace;font-size:10px;color:${d.ok?'var(--green)':'var(--red)'};font-weight:500;flex-shrink:0">${d.status || (d.ok?'ok':'fail')} · ${d.durationMs}ms</span>
    </div>`).join('') || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:14px 0;font-style:italic">No deliveries yet. Fire a test on a webhook above to verify.</div>';

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Webhooks</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" onclick="whNew()">+ New Webhook</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Webhooks</div></div>
        <div class="kpi"><div class="kpi-n c-green">${activeN}</div><div class="kpi-l">Active</div></div>
        <div class="kpi"><div class="kpi-n c-red">${failingN}</div><div class="kpi-l">Last attempt failed</div></div>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr>
            <th>ID</th><th>Name</th><th>URL</th><th>Events</th><th>Last fired</th><th>Status</th>
            <th style="text-align:center">Active</th>
            ${admin?'<th style="text-align:right">Actions</th>':''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${WEBHOOKS.length === 0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No webhooks configured</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:18px">
          <div class="card-title" style="margin-bottom:10px">Recent deliveries (${recentDeliveries.length})</div>
          ${deliveryRows}
        </div>
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5;padding:0 4px">Webhooks fire as POST requests with a JSON body — <code style="font-family:'DM Mono',monospace">{event, at, payload}</code> — and an <code style="font-family:'DM Mono',monospace">X-Webhook-Event</code> header. If a secret is set the body is HMAC-SHA256 signed with it and the signature ships as <code style="font-family:'DM Mono',monospace">X-Webhook-Signature: sha256=&lt;hex&gt;</code> so the receiver can verify the request came from us. Browser CORS will block most direct cross-origin endpoints — route via a relay (workflow tool or serverless function) when targeting third-party services.</div>
      </div>
    </div>`;
}
