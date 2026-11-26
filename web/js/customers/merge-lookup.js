import { apiGet, apiPost, getBrandId, getWorkspaceId, getJwt } from '../core/api-client.js';
import { CUSTOMERS } from '../core/data.js';
import { loadWorkspaceData } from '../core/bootstrap.js';
import { can } from '../core/permissions.js';
import { registerActions, registerInputActions, registerChangeActions } from '../core/event-delegation.js';

let active = null;

function current(ctx) {
  return ctx && active === ctx && document.getElementById('merge-player-lookup') === ctx.root
    && ctx.brand === getBrandId() && ctx.workspace === getWorkspaceId() && ctx.jwt === getJwt()
    && can('customers.merge');
}

export function mountMergeLookup(sourceId, onSelect) {
  const root = document.getElementById('merge-player-lookup');
  if (!root || !getBrandId()) return;
  root.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px">Search Maestro</div>
    <fieldset style="border:0;padding:0;margin:0;min-width:0">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <select class="form-input" aria-label="Search Maestro by" data-change-action="mergeLookup.clear" style="width:auto">
          <option value="email">Email or username</option><option value="memberId">Member ID</option>
        </select>
        <input class="form-input" aria-label="Maestro search value" placeholder="Enter the exact value" data-input-action="mergeLookup.clear" style="flex:1;min-width:140px"/>
        <button type="button" class="btn btn-sm" data-action="mergeLookup.search">Search Maestro</button>
      </div>
      <div role="status" aria-live="polite" style="margin-top:10px"></div>
    </fieldset>
    <p style="font-size:12px;color:var(--ink3)">Search this brand by exact email, username or Member ID. Selecting a player adds their contact to Respovia before you confirm the merge.</p>`;
  active = { root, sourceId, onSelect, brand: getBrandId(), workspace: getWorkspaceId(), jwt: getJwt(), key: null, busy: false };
  root.querySelector('input').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); search(); }
  });
}

function clear() {
  if (!current(active) || active.busy) return;
  active.key = null;
  active.root.querySelector('[role="status"]').textContent = '';
}

async function search() {
  const ctx = active;
  if (!current(ctx) || ctx.busy) return;
  const value = ctx.root.querySelector('input').value.trim();
  const key = ctx.root.querySelector('select').value;
  const status = ctx.root.querySelector('[role="status"]');
  ctx.key = null;
  if (!value) { status.textContent = 'Enter an email, username or Member ID.'; return; }
  ctx.busy = true;
  ctx.root.querySelector('fieldset').disabled = true;
  status.textContent = 'Searching Maestro…';
  try {
    const res = await apiGet(`/api/v1/maestro/players?${key}=${encodeURIComponent(value)}`, { brand: true });
    if (!current(ctx)) return;
    const player = res.member || {};
    if (!player.email) throw new Error('This player has no email on file and cannot be added to Respovia.');
    ctx.key = { [key]: value };
    const name = [player.firstName, player.lastName].filter(Boolean).join(' ') || player.username || player.email;
    status.innerHTML = `<div style="overflow-wrap:anywhere"><strong>${window.escHtml(name)}</strong><br>${window.escHtml(player.email)}<br>Member ID: ${window.escHtml(String(player.userId ?? player.memberId ?? '—'))}</div>
      <button type="button" class="btn btn-sm" style="margin-top:8px" data-action="mergeLookup.select">Use this player</button>`;
  } catch (err) {
    if (current(ctx)) status.textContent = err?.status === 404 ? 'No player found. Check the exact value and try again.' : err?.message || 'Could not search Maestro. Try again.';
  } finally {
    ctx.busy = false;
    if (current(ctx)) ctx.root.querySelector('fieldset').disabled = false;
  }
}

async function select() {
  const ctx = active;
  if (!current(ctx) || ctx.busy || !ctx.key) return;
  ctx.busy = true;
  ctx.root.querySelector('fieldset').disabled = true;
  const status = ctx.root.querySelector('[role="status"]');
  status.textContent = 'Preparing contact…';
  try {
    const res = await apiPost('/api/v1/customers/from-player', ctx.key, { brand: true });
    if (!current(ctx)) return;
    if (!res?.customer?.id) throw new Error('Could not prepare this contact. Search again to retry.');
    await loadWorkspaceData();
    if (!current(ctx)) return;
    const target = CUSTOMERS.find(c => c._uuid === res.customer.id);
    if (!target || target.erased || target.mergedInto || target._mergedIntoUuid) throw new Error('This contact is no longer available for merging.');
    if (target.id === ctx.sourceId) throw new Error('This is the contact you are merging. Search for the other account.');
    ctx.onSelect(target.id);
  } catch (err) {
    if (current(ctx)) status.textContent = err?.message || 'Could not prepare this contact. Search again to retry.';
  } finally {
    ctx.busy = false;
    if (current(ctx)) ctx.root.querySelector('fieldset').disabled = false;
  }
}

registerActions({ 'mergeLookup.search': search, 'mergeLookup.select': select });
registerInputActions({ 'mergeLookup.clear': clear });
registerChangeActions({ 'mergeLookup.clear': clear });
