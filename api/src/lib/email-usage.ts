import { z } from 'zod';
import { env } from './env.js';
import { getDb } from './db.js';

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Server = z.object({ ID: Count, ApiTokens: z.array(z.string().min(1)).min(1) });
const ServerPage = z.object({ TotalCount: Count, Servers: z.array(Server) });
const Inbound = z.object({ TotalCount: Count });
const Streams = z.object({ TotalCount: Count, MessageStreams: z.array(z.object({
  ID: z.string().min(1), MessageStreamType: z.enum(['Inbound', 'Transactional', 'Broadcasts']),
})) });
const Outbound = z.object({ TotalCount: Count, Messages: z.array(z.object({
  MessageID: z.string().min(1), Recipients: z.array(z.string()).min(1),
})) });
const STALE_MS = 2 * 60 * 60 * 1000;

export function usageThreshold(used: number, allowance: number): number {
  return [100, 90, 80].find(value => used >= allowance * value / 100) ?? 0;
}

// Postmark's date filters use Eastern time. Calendar arithmetic deliberately
// clamps a renewal on the 29th–31st to the final day of shorter months.
export function usagePeriod(now: Date, renewalDay: number) {
  if (!Number.isInteger(renewalDay) || renewalDay < 1 || renewalDay > 31) {
    throw new Error('Set the Postmark renewal day before enabling monitoring.');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (name: string) => Number(parts.find(p => p.type === name)!.value);
  const year = part('year'), month = part('month') - 1;
  const date = (y: number, m: number) => {
    const first = new Date(Date.UTC(y, m, 1));
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(renewalDay, lastDay)))
      .toISOString().slice(0, 10);
  };
  const today = `${year}-${String(month + 1).padStart(2, '0')}-${String(part('day')).padStart(2, '0')}`;
  const started = today >= date(year, month);
  return { start: date(year, month - (started ? 0 : 1)), end: date(year, month + (started ? 1 : 0)), today };
}

export type UsageSnapshot = {
  start: string; end: string; allowance: number; servers: number;
  inbound: number; outbound: number; total: number; threshold: number;
};

// Only counts leave this function. Server tokens and message contents never
// enter storage, logging or an API response. Each request and the entire poll
// are bounded; a partial account scan is a failure, never a low usage result.
export async function collectEmailUsage(
  accountToken: string, allowance: number, renewalDay: number,
  now = new Date(), fetcher: typeof fetch = fetch,
): Promise<UsageSnapshot> {
  const period = usagePeriod(now, renewalDay);
  if (!accountToken) throw new Error('Postmark account access is not configured.');
  const deadline = Date.now() + 45_000;
  async function request(path: string, token: string, account = false): Promise<unknown> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Postmark usage check timed out.');
    let response: Response;
    try {
      response = await fetcher(`https://api.postmarkapp.com${path}`, {
        headers: { Accept: 'application/json', [account ? 'X-Postmark-Account-Token' : 'X-Postmark-Server-Token']: token },
        signal: AbortSignal.timeout(Math.min(8000, remaining)), redirect: 'error',
      });
    } catch { throw new Error('Postmark usage check could not connect.'); }
    if (!response.ok) throw new Error(`Postmark usage check returned HTTP ${response.status}.`);
    try { return await response.json(); }
    catch { throw new Error('Postmark returned an invalid usage response.'); }
  }
  const servers = new Map<number, z.infer<typeof Server>>();
  let offset = 0, expected: number | undefined;
  while (true) {
    const page = ServerPage.parse(await request(`/servers?count=100&offset=${offset}`, accountToken, true));
    if (expected !== undefined && expected !== page.TotalCount) throw new Error('Postmark server list changed during the check.');
    expected = page.TotalCount;
    if (expected > 500) throw new Error('Postmark account exceeds the monitor server limit.');
    for (const server of page.Servers) servers.set(server.ID, server);
    offset += page.Servers.length;
    if (offset >= expected) break;
    if (!page.Servers.length) throw new Error('Postmark returned an incomplete server list.');
  }
  if (!servers.size || servers.size !== expected) throw new Error('Postmark returned an incomplete server list.');
  let inbound = 0, outbound = 0;
  for (const server of servers.values()) {
    const dates = `fromdate=${period.start}T00:00:00&todate=${period.today}T23:59:59`;
    const [streamData, received] = await Promise.all([
      request('/message-streams?MessageStreamType=All&IncludeArchivedStreams=true', server.ApiTokens[0]),
      request(`/messages/inbound?count=1&offset=0&status=processed&${dates}`, server.ApiTokens[0]),
    ]);
    inbound += Inbound.parse(received).TotalCount;
    const streams = Streams.parse(streamData);
    if (new Set(streams.MessageStreams.map(s => s.ID)).size !== streams.TotalCount) {
      throw new Error('Postmark returned an incomplete stream list.');
    }
    for (const stream of streams.MessageStreams.filter(s => s.MessageStreamType !== 'Inbound')) {
      const messages = new Map<string, number>();
      let offset = 0, expected: number | undefined;
      while (true) {
        const page = Outbound.parse(await request(`/messages/outbound?count=500&offset=${offset}&status=sent&messagestream=${encodeURIComponent(stream.ID)}&${dates}`, server.ApiTokens[0]));
        if (expected !== undefined && expected !== page.TotalCount) throw new Error('Postmark message history changed during the check.');
        expected = page.TotalCount;
        if (expected > 10000) throw new Error('Postmark message search limit reached.');
        for (const message of page.Messages) messages.set(message.MessageID, message.Recipients.length);
        offset += page.Messages.length;
        if (offset >= expected) break;
        if (!page.Messages.length) throw new Error('Postmark returned incomplete message history.');
      }
      if (messages.size !== expected) throw new Error('Postmark returned incomplete message history.');
      // Count recipients, not just messages with potentially multiple To/Cc/Bcc.
      for (const recipients of messages.values()) outbound += recipients;
    }
  }
  const total = Count.parse(inbound + outbound);
  return { start: period.start, end: period.end, allowance, servers: servers.size,
    inbound, outbound, total, threshold: usageThreshold(total, allowance) };
}

function configured() { return Boolean(env.POSTMARK_ACCOUNT_TOKEN && env.EMAIL_USAGE_RENEWAL_DAY); }
function slackUrl() { return env.EMAIL_USAGE_SLACK_WEBHOOK_URL || env.SLACK_ALERT_WEBHOOK_URL; }

export function usageState(snapshot: UsageSnapshot | null, checkedAt: Date | null, error: string | null, now = new Date()) {
  if (!configured()) return 'unconfigured';
  if (error) return 'unavailable';
  if (!snapshot || !checkedAt) return 'pending';
  const period = usagePeriod(now, env.EMAIL_USAGE_RENEWAL_DAY);
  if (snapshot.start !== period.start || snapshot.end !== period.end || snapshot.allowance !== env.EMAIL_USAGE_ALLOWANCE
    || now.getTime() - checkedAt.getTime() > STALE_MS) return 'stale';
  return snapshot.threshold ? 'warning' : 'current';
}

export async function readEmailUsage() {
  const [row] = await getDb()`select snapshot, checked_at, attempted_at, last_error from email_usage_monitor where singleton`;
  return { state: usageState(row?.snapshot ?? null, row?.checked_at ?? null, row?.last_error ?? null),
    snapshot: row?.snapshot ?? null, checked_at: row?.checked_at ?? null,
    attempted_at: row?.attempted_at ?? null, error: row?.last_error ?? null,
    allowance: env.EMAIL_USAGE_ALLOWANCE, renewal_day: env.EMAIL_USAGE_RENEWAL_DAY,
    slack_configured: Boolean(slackUrl()) };
}

export async function runEmailUsageJob() {
  if (!configured()) return { ok: false, error: 'Email usage monitoring is not configured.' };
  // Serialize scheduled/manual invocations across processes. The fixed row
  // exists from migration, and SKIP LOCKED avoids tying up a second worker.
  return getDb().begin(async sql => {
    const [row] = await sql`select * from email_usage_monitor where singleton for update skip locked`;
    if (!row) return { ok: true, skipped: true };
    const now = new Date();
    let snapshot: UsageSnapshot;
    try {
      snapshot = await collectEmailUsage(env.POSTMARK_ACCOUNT_TOKEN, env.EMAIL_USAGE_ALLOWANCE, env.EMAIL_USAGE_RENEWAL_DAY, now);
    } catch {
      // Never publish raw provider/schema errors: they can contain credentials.
      await sql`update email_usage_monitor set attempted_at=${now}, last_error='Email usage could not be checked. The previous count may be outdated.' where singleton`;
      return { ok: false, error: 'Email usage check failed.' };
    }
    await sql`update email_usage_monitor set snapshot=${sql.json(snapshot)}, checked_at=${now}, attempted_at=${now}, last_error=null where singleton`;
    const cycle = `${snapshot.start}/${snapshot.end}/${snapshot.allowance}`;
    const previous = row.notified_cycle === cycle ? row.notified_threshold : 0;
    const url = slackUrl();
    if (snapshot.threshold > previous && url) {
      try {
        const response = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({ text: `Respovia email usage: ${snapshot.threshold}% threshold reached.\nEstimated usage: ${snapshot.total.toLocaleString('en-US')} of ${snapshot.allowance.toLocaleString('en-US')} emails (${snapshot.start} to ${snapshot.end}). Includes incoming and outgoing mail across ${snapshot.servers} Postmark server(s). Paid-plan overages may apply; this is not a delivery shutdown notice. Check Postmark for the billed total.` }),
        });
        if (!response.ok) throw new Error('Slack rejected the alert');
        await sql`update email_usage_monitor set notified_cycle=${cycle}, notified_threshold=${snapshot.threshold} where singleton`;
      } catch {
        // Retain the accurate snapshot and retry notification on the next run.
        return { ok: false, error: 'Email usage was checked but the Slack warning could not be delivered.' };
      }
    }
    return { ok: true };
  });
}
