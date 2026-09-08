import { apiGet, getJwt, getWorkspaceId } from '../core/api-client.js';
import { registerActions } from '../core/event-delegation.js';

const labels = { low: 'Low', medium: 'Medium', high: 'High' };
const count = n => Number.isInteger(n) && n >= 0 ? String(n) : 'Unavailable';

export function riskContent(data) {
  const level = data?.aml?.state === 'available' && Object.hasOwn(labels, data.aml.level) ? data.aml.level : null;
  return `<dl class="customer-risk-grid">
    <div><dt>Open complaints</dt><dd>${count(data?.complaints?.open)}</dd></div>
    <div><dt>Complaints created in past 30 days</dt><dd>${count(data?.complaints?.created_last_30_days)}</dd></div>
    <div><dt>AML risk</dt><dd${level ? ` class="risk-${level}"` : ''}>${level ? labels[level] : 'Unavailable'}</dd></div>
    <div><dt>Responsible gambling</dt><dd>Unavailable</dd></div>
    <div><dt>Customer due diligence</dt><dd>Unavailable</dd></div>
    <div><dt>Closed account</dt><dd>Unavailable</dd></div>
  </dl><p class="customer-risk-note">Complaint counts use the Complaints category. The current integration does not supply RG, CDD or closed-account details.</p>`;
}

async function loadRisk(slot) {
  if (!slot || slot.dataset.loading === 'true') return;
  const jwt = getJwt(), workspace = getWorkspaceId();
  if (!jwt || !workspace) return;
  slot.dataset.loading = 'true';
  slot.setAttribute('aria-busy', 'true');
  const body = slot.querySelector('[data-risk-body]');
  body.innerHTML = '<p class="customer-risk-note" role="status">Loading risk indicators…</p>';
  const current = () => slot.isConnected && getJwt() === jwt && getWorkspaceId() === workspace;
  try {
    const data = await apiGet(`/api/v1/customers/${encodeURIComponent(slot.dataset.customerRisk)}/risk`);
    if (current()) body.innerHTML = riskContent(data);
  } catch {
    if (current()) body.innerHTML = '<p class="customer-risk-note" role="status">Risk indicators could not be loaded. Select Refresh to try again.</p>';
  } finally {
    if (current()) {
      slot.dataset.loading = 'false';
      slot.setAttribute('aria-busy', 'false');
    }
  }
}

export function renderRiskPanel(customer) {
  if (!customer._uuid || customer.erased || customer.mergedInto || customer._mergedIntoUuid) return '';
  const id = customer._uuid;
  // Each render gets a fresh element. A response for a detached element never
  // lands on a new profile, even if both share a display ID across workspaces.
  queueMicrotask(() => {
    const slot = document.querySelector('[data-customer-risk]');
    if (slot?.dataset.customerRisk === id) void loadRisk(slot);
  });
  return `<section class="card customer-risk" data-customer-risk="${window.escAttr(id)}" aria-busy="true">
    <div class="customer-risk-heading"><h2 class="card-title">Risk indicators</h2>
      <button class="btn btn-sm" data-action="customerRisk.refresh" aria-label="Refresh risk indicators">Refresh</button></div>
    <div data-risk-body><p class="customer-risk-note" role="status">Loading risk indicators…</p></div>
  </section>`;
}

registerActions({
  'customerRisk.refresh': (_ds, el) => { void loadRisk(el.closest('[data-customer-risk]')); },
});
