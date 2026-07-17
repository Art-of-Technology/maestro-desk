import { SLA_POLICIES, TICKETS } from '../core/data.js';
// ─── SLA evaluator + business hours ──────────────────────────────────────────
// Two tightly-coupled features in one module:
//
//   1. SLA evaluator — computeTicketSLA(t) returns a status (ok / warn /
//      breach / snoozed) per ticket based on first-response and resolution
//      timers measured against the matching SLA_POLICIES entry. The clock is
//      anchored on slaNowForDemo() so seeded fixture dates produce believable
//      states without making everything a breach.
//
//   2. Business hours — when BUSINESS_HOURS.enabled, only minutes inside the
//      configured per-day windows count toward the SLA timer, pausing it
//      overnight, on weekends, and on holiday dates. businessMinutesBetween
//      is the hot path; it caches results keyed by (startMs, endMs) because
//      refreshAllSLA reuses the same slaNow anchor across all tickets.
//
// No external reaches needed — this module only depends on TICKETS and
// SLA_POLICIES (imported from core/data.js). Pure functions over data, no UI
// side effects.

// Demo "now" = 1 day after the latest seeded ticket creation date, so old fixture
// dates produce believable SLA states without making everything a breach.
let _slaNowCache = null;
export function slaNowForDemo() {
  if (_slaNowCache) return _slaNowCache;
  const dates = TICKETS.map(t => new Date(t.created)).filter(d => !isNaN(d)).sort((a, b) => b - a);
  const latest = dates[0] || new Date();
  _slaNowCache = new Date(latest.getTime() + 24 * 60 * 60 * 1000);
  return _slaNowCache;
}
export function invalidateSLAClock() {
  _slaNowCache = null;
  bhInvalidateCache();
}

export function findMatchingSLAPolicy(t) {
  if (!t.priority) return null;
  const candidates = SLA_POLICIES.filter(p => p.status === 'active' && p.priority === t.priority);
  // Prefer specific category match over the catch-all "all"
  return candidates.find(p => p.category === t.category)
      || candidates.find(p => p.category === 'all')
      || null;
}

export function ticketFirstResponseMinutes(t) {
  const msgs = t.msgs || [];
  const firstCust = msgs.find(m => m.r === 'customer');
  if (!firstCust) return null;
  const idx = msgs.indexOf(firstCust);
  const firstAgent = msgs.find((m, i) => i > idx && (m.r === 'agent' || m.r === 'ai'));
  if (!firstAgent) return null;
  const a = (firstCust.ts || '').match(/^(\d+):(\d+)/);
  const b = (firstAgent.ts || '').match(/^(\d+):(\d+)/);
  if (!a || !b) return null;
  const ah = parseInt(a[1], 10), am = parseInt(a[2], 10);
  const bh = parseInt(b[1], 10), bm = parseInt(b[2], 10);
  let delta = (bh - ah) * 60 + (bm - am);
  // Cross-day responses (e.g. customer 23:55 → agent 00:10) come out negative; assume the
  // reply was within 24h and roll forward rather than silently clamping to "instant".
  if (delta < 0) delta += 24 * 60;
  return delta;
}

export function ticketElapsedMinutes(t) {
  if (!t.created) return 0;
  const created = new Date(t.created);
  if (isNaN(created)) return 0;
  if (BUSINESS_HOURS.enabled) {
    return businessMinutesBetween(created.getTime(), slaNowForDemo().getTime());
  }
  return Math.max(0, Math.floor((slaNowForDemo() - created) / 60000));
}

// Drives the SLA elapsed-time calculation. When enabled, only minutes that
// fall inside a configured business-hours window count toward the SLA timer,
// pausing it overnight, on weekends, and on holiday dates. When disabled the
// timer runs 24/7 (legacy behaviour).
export const BUSINESS_HOURS = {
  enabled: true,
  days: [
    { day: 0, label: 'Sun', enabled: false, start: '09:00', end: '17:00' },
    { day: 1, label: 'Mon', enabled: true,  start: '09:00', end: '17:00' },
    { day: 2, label: 'Tue', enabled: true,  start: '09:00', end: '17:00' },
    { day: 3, label: 'Wed', enabled: true,  start: '09:00', end: '17:00' },
    { day: 4, label: 'Thu', enabled: true,  start: '09:00', end: '17:00' },
    { day: 5, label: 'Fri', enabled: true,  start: '09:00', end: '17:00' },
    { day: 6, label: 'Sat', enabled: false, start: '09:00', end: '17:00' },
  ],
  holidays: ['2026-12-25', '2026-12-26', '2026-01-01'],
};

export function bhParseHM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, min };
}

export function isWithinBusinessHours(date) {
  if (!BUSINESS_HOURS.enabled) return true;
  const cfg = BUSINESS_HOURS.days[date.getDay()];
  if (!cfg || !cfg.enabled) return false;
  const ymd = date.toISOString().slice(0, 10);
  if (BUSINESS_HOURS.holidays.includes(ymd)) return false;
  const start = bhParseHM(cfg.start), end = bhParseHM(cfg.end);
  if (!start || !end) return false;
  const mins = date.getHours() * 60 + date.getMinutes();
  return mins >= (start.h * 60 + start.min) && mins < (end.h * 60 + end.min);
}

// Cached results keyed by (startMs, endMs). refreshAllSLA on many tickets
// re-uses the same slaNow anchor, so most calls share startMs (created date)
// or endMs across calls. Cache invalidates on every config edit + slaNow reset.
let _bizMinutesCache = new Map();
export function bhInvalidateCache() { _bizMinutesCache = new Map(); }

export function businessMinutesBetween(startMs, endMs) {
  if (!BUSINESS_HOURS.enabled) return Math.max(0, Math.floor((endMs - startMs) / 60000));
  if (endMs <= startMs) return 0;
  const cacheKey = startMs + '-' + endMs;
  const hit = _bizMinutesCache.get(cacheKey);
  if (hit !== undefined) return hit;
  let total = 0;
  const startDay = new Date(startMs);
  startDay.setHours(0, 0, 0, 0);
  // Walk one calendar day at a time and sum the overlap with that day's window.
  // Strict `<` so an endMs at midnight doesn't trigger an extra empty iteration.
  for (let d = startDay.getTime(); d < endMs; d += 86400000) {
    const day = new Date(d);
    const cfg = BUSINESS_HOURS.days[day.getDay()];
    if (!cfg || !cfg.enabled) continue;
    if (BUSINESS_HOURS.holidays.includes(day.toISOString().slice(0, 10))) continue;
    const start = bhParseHM(cfg.start), end = bhParseHM(cfg.end);
    if (!start || !end) continue;
    const dayStart = new Date(d); dayStart.setHours(start.h, start.min, 0, 0);
    const dayEnd   = new Date(d); dayEnd.setHours(end.h,   end.min,   0, 0);
    const winStart = Math.max(dayStart.getTime(), startMs);
    const winEnd   = Math.min(dayEnd.getTime(),   endMs);
    if (winEnd > winStart) total += Math.floor((winEnd - winStart) / 60000);
  }
  _bizMinutesCache.set(cacheKey, total);
  return total;
}

export const SLA_WARN_FRACTION = 0.7; // warn at 70 % of the window

// Compact "Xm" / "Yh Zm" / "Nd Yh" formatter for SLA windows and elapsed
// timers. Pure; used by both the SLA Policies config page and the ticket
// sidebar's SLA progress strip.
export function fmtSLAMinutes(min) {
  if (!min || min < 1) return '—';
  if (min < 60) return `${min}m`;
  if (min < 1440) {
    const h = Math.floor(min / 60), rest = min % 60;
    return rest ? `${h}h ${rest}m` : `${h}h`;
  }
  const d = Math.floor(min / 1440), rest = min % 1440;
  return rest ? `${d}d ${Math.round(rest/60)}h` : `${d}d`;
}

export function computeTicketSLA(t) {
  const policy = findMatchingSLAPolicy(t);
  const elapsedMin = ticketElapsedMinutes(t);
  const firstRespMin = ticketFirstResponseMinutes(t);
  const isResolved = t.status === 'resolved';
  const isSnoozed  = t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now();

  if (!policy) return { status: 'ok', policy: null, elapsedMin, firstRespMin, firstResponseStatus: 'ok', resolutionStatus: 'ok', isResolved, isSnoozed };
  if (isSnoozed) return { status: 'snoozed', policy, elapsedMin, firstRespMin, firstResponseStatus: 'snoozed', resolutionStatus: 'snoozed', isResolved, isSnoozed };

  // Awaiting first response → the clock still runs against elapsed time;
  // once replied, judge the recorded response time. Resolution breaches are
  // forgiven once resolved (live-badge semantics; the breach report's
  // evaluateSLATimestamps deliberately does not forgive them).
  const firstResponseStatus = firstRespMin == null
    ? targetStatus(elapsedMin, policy.firstResponseMin, false)
    : targetStatus(firstRespMin, policy.firstResponseMin, true);
  const resolutionStatus = isResolved ? 'ok' : targetStatus(elapsedMin, policy.resolutionMin, false);

  const status = worstOf(firstResponseStatus, resolutionStatus);
  return { status, policy, elapsedMin, firstRespMin, firstResponseStatus, resolutionStatus, isResolved };
}

// Shared warn/breach threshold ladder for one SLA target. Both evaluators
// (computeTicketSLA below and evaluateSLATimestamps for the breach report)
// route through this so the subtle boundary semantics stay single-sourced:
// while the clock is still running a target breaches AT the window (>=,
// it can only get worse); once it stopped, exactly-on-target is met (>).
function targetStatus(elapsedMin, targetMin, stopped) {
  if (stopped ? elapsedMin > targetMin : elapsedMin >= targetMin) return 'breach';
  if (elapsedMin >= targetMin * SLA_WARN_FRACTION) return 'warn';
  return 'ok';
}

const STATUS_ORDER = { ok: 0, warn: 1, breach: 2, snoozed: 0 };
function worstOf(a, b) { return STATUS_ORDER[a] >= STATUS_ORDER[b] ? a : b; }

// Timestamp-based SLA evaluator for the SLA Breach report. Unlike
// computeTicketSLA (which works off demo HH:MM message strings and the
// slaNowForDemo anchor), this takes absolute epoch-ms timestamps as supplied
// by the reports API and a real `nowMs`. Elapsed time is business-hours
// aware via businessMinutesBetween, same as the rest of the engine.
//
// One deliberate divergence: a ticket resolved AFTER its resolution window
// still counts as a resolution breach here (computeTicketSLA forgives it —
// fine for a live "is this ticket on fire" badge, wrong for a report of
// what breached). Overrun fields are minutes past the target, only set
// when that target breached.
//
// firstCustomerMs anchors the first-response obligation: when null (an
// agent-initiated outbound thread) there is nothing to respond to and the
// first-reply target is skipped. Resolving a ticket stops the first-reply
// clock too — a thread closed without a public reply is judged on
// created→resolved, not created→forever.
export function evaluateSLATimestamps({ createdMs, firstCustomerMs, firstReplyMs, resolvedMs, nowMs, policy }) {
  if (!policy) return null;

  const frStop = firstReplyMs ?? resolvedMs;
  const frMin  = businessMinutesBetween(createdMs, frStop ?? nowMs);
  const resMin = businessMinutesBetween(createdMs, resolvedMs ?? nowMs);

  const firstResponseStatus = firstCustomerMs == null
    ? 'ok'
    : targetStatus(frMin, policy.firstResponseMin, frStop != null);
  const resolutionStatus = targetStatus(resMin, policy.resolutionMin, resolvedMs != null);

  return {
    status: worstOf(firstResponseStatus, resolutionStatus),
    firstResponseStatus,
    resolutionStatus,
    firstResponseMinutes: frMin,
    resolutionMinutes: resMin,
    firstResponseOverrunMin: firstResponseStatus === 'breach' ? frMin - policy.firstResponseMin : null,
    resolutionOverrunMin: resolutionStatus === 'breach' ? resMin - policy.resolutionMin : null,
  };
}

export function refreshTicketSLA(t) {
  const r = computeTicketSLA(t);
  t.sla = r.status;
  t.slaPolicyId = r.policy ? r.policy.id : null;
  t.slaFirstResponseStatus = r.firstResponseStatus;
  t.slaResolutionStatus = r.resolutionStatus;
  return r;
}

export function refreshAllSLA() { TICKETS.forEach(refreshTicketSLA); }
