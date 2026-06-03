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

  let firstResponseStatus = 'ok';
  if (firstRespMin == null) {
    // Awaiting first response; clock is running against firstResponseMin
    if (elapsedMin >= policy.firstResponseMin) firstResponseStatus = 'breach';
    else if (elapsedMin >= policy.firstResponseMin * SLA_WARN_FRACTION) firstResponseStatus = 'warn';
  } else {
    if (firstRespMin > policy.firstResponseMin) firstResponseStatus = 'breach';
    else if (firstRespMin >= policy.firstResponseMin * SLA_WARN_FRACTION) firstResponseStatus = 'warn';
  }

  let resolutionStatus = 'ok';
  if (!isResolved) {
    if (elapsedMin >= policy.resolutionMin) resolutionStatus = 'breach';
    else if (elapsedMin >= policy.resolutionMin * SLA_WARN_FRACTION) resolutionStatus = 'warn';
  }

  const order = { ok: 0, warn: 1, breach: 2 };
  const status = order[firstResponseStatus] >= order[resolutionStatus] ? firstResponseStatus : resolutionStatus;
  return { status, policy, elapsedMin, firstRespMin, firstResponseStatus, resolutionStatus, isResolved };
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
