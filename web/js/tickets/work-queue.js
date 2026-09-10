import { TICKETS } from '../core/data.js';
import { apiGet, getJwt, getWorkspaceId } from '../core/api-client.js';
import { buildTicketLookups, updateOrInsertTicket } from '../core/bootstrap.js';
import { evaluateSLATimestamps, findMatchingSLAPolicy } from './sla.js';

export function isOutstanding(t) {
  return !t.mergedInto && !t._mergedIntoUuid && !['resolved', 'closed'].includes(t.status);
}

export function compareUrgency(a, b) {
  const tier = t => t.sla === 'breach' ? 0 : t.status === 'escalated' ? 1 : t.sla === 'warn' ? 2 : 3;
  const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
  return tier(a) - tier(b) || (a.slaRemainingMin ?? Infinity) - (b.slaRemainingMin ?? Infinity)
    || (priority[a.priority] ?? 4) - (priority[b.priority] ?? 4)
    || (a.created || '').localeCompare(b.created || '') || a.id.localeCompare(b.id);
}

let identity = null;
let generation = 0;
let states = {};
function context() {
  const key = `${getWorkspaceId() || ''}:${getJwt() || ''}`;
  if (identity !== key) { identity = key; generation++; states = {}; }
  return key;
}

export function invalidateWorkQueue() { generation++; states = {}; }

export function workQueueState(scope = 'outstanding') {
  context();
  if (!getJwt()) return { ready: true, loading: false, error: null };
  return states[scope] ||= { ready: false, loading: false, error: null };
}

// Commit only after every page succeeds; no false zeros or partial totals.
// The session/workspace and generation guards also discard late responses.
export function loadWorkQueue(scope = 'outstanding') {
  const key = context(), version = generation;
  const state = workQueueState(scope);
  if (state.loading) return state.promise;
  if (state.ready || !getJwt()) return Promise.resolve();
  state.loading = true; state.error = null;
  state.promise = fetchWorkQueue(scope, state, key, version);
  return state.promise;
}

async function fetchWorkQueue(scope, state, key, version) {
  try {
    const rows = [];
    let cursor = null;
    do {
      const res = await apiGet(`/api/v1/tickets/work-index?scope=${scope}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
      if (key !== context() || generation !== version) return;
      if (!Array.isArray(res?.tickets)) throw new Error('Invalid ticket index.');
      for (const row of res.tickets) {
        if (!row || typeof row.id !== 'string' || !row.id || typeof row.display_id !== 'string'
            || typeof row.status_key !== 'string' || typeof row.subject !== 'string'
            || typeof row.priority_key !== 'string' || !row.created_at || !Number.isFinite(Date.parse(row.created_at))
            || row.deleted_at || row.merged_into_id
            || (scope === 'history') !== ['resolved', 'closed'].includes(row.status_key)) {
          throw new Error('Invalid ticket row.');
        }
        rows.push(row);
      }
      if (res.next && res.next === cursor) throw new Error('Ticket cursor did not advance.');
      cursor = res.next;
    } while (cursor);
    const lookups = buildTicketLookups();
    const ids = new Set(rows.map(r => r.id));
    if (ids.size !== rows.length) throw new Error('Duplicate ticket rows.');
    // Prepare against copies. Mapping/validation failures leave the shared
    // collection and existing detail-view object references untouched.
    const staged = TICKETS.map(t => ({ ...t }));
    // Prune disappeared rows in this scope (deleted, merged, or moved to the
    // other scope). Keep other-scope/detail data intact.
    for (let i = staged.length - 1; i >= 0; i--) {
      const t = staged[i];
      if (t._uuid && (scope === 'outstanding' ? isOutstanding(t) : !isOutstanding(t)) && !ids.has(t._uuid)) staged.splice(i, 1);
    }
    for (const row of rows) {
      updateOrInsertTicket(row, lookups, staged);
      const t = staged.find(t => t._uuid === row.id);
      if (!t) throw new Error('Ticket mapping failed.');
      t.created = row.created_at;
      t.customerName = row.customer_name || '';
      t.agent = row.assignee_name || '';
      t.tags = row.tags || [];
      t._queueTiming = { firstCustomer: row.first_customer_at, firstReply: row.first_agent_reply_at };
    }
    const existing = new Map(TICKETS.map(t => [t._uuid || t.id, t]));
    const committed = staged.map(t => {
      const original = existing.get(t._uuid || t.id);
      return original ? Object.assign(original, t) : t;
    });
    TICKETS.length = 0;
    for (const t of committed) TICKETS.push(t);
    state.ready = true;
  } catch (error) {
    if (key === context() && generation === version) state.error = 'Could not load all tickets. Please retry.';
  } finally { state.loading = false; }
}

export function refreshQueueUrgency(nowMs = Date.now()) {
  let changed = false;
  for (const t of TICKETS) {
    if (!isOutstanding(t) || !t._queueTiming) continue;
    const policy = findMatchingSLAPolicy(t);
    const result = evaluateSLATimestamps({
      createdMs: new Date(t.created).getTime(),
      firstCustomerMs: t._queueTiming.firstCustomer ? new Date(t._queueTiming.firstCustomer).getTime() : null,
      firstReplyMs: t._queueTiming.firstReply ? new Date(t._queueTiming.firstReply).getTime() : null,
      resolvedMs: null, nowMs, policy,
    });
    const snoozed = t.snoozedUntil && new Date(t.snoozedUntil).getTime() > nowMs;
    const status = snoozed ? 'snoozed' : result?.status || 'ok';
    if (t.sla !== status) changed = true;
    t.sla = status;
    t.slaRemainingMin = result && !snoozed ? Math.min(
      policy.resolutionMin - result.resolutionMinutes,
      t._queueTiming.firstCustomer && !t._queueTiming.firstReply ? policy.firstResponseMin - result.firstResponseMinutes : Infinity,
    ) : Infinity;
  }
  return changed;
}
