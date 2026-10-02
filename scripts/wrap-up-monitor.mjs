import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sendAlert } from './deployment-alert.mjs';

const repository = 'Art-of-Technology/maestro-desk';
const workflow = `https://github.com/${repository}/actions/workflows/wrap-up-monitor.yml`;
const parts = date => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(date).map(p => [p.type, p.value]));
const dateKey = p => `${p.year}-${p.month}-${p.day}`;
const minutes = p => Number(p.hour) * 60 + Number(p.minute);

export function missingReport(receipt, now, since) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since || '') || !Number.isFinite(Date.parse(since))) throw new Error('Missing monitor activation date');
  const today = parts(now);
  const expected = new Date(`${dateKey(today)}T12:00:00Z`);
  if (minutes(today) < 1110) expected.setUTCDate(expected.getUTCDate() - 1);
  while ([0, 6].includes(expected.getUTCDay())) expected.setUTCDate(expected.getUTCDate() - 1);
  const date = expected.toISOString().slice(0, 10);
  if (date < since) return null;
  const coverage = Date.parse(receipt?.coverageThrough);
  const verified = Date.parse(receipt?.verifiedAt);
  const confirmed = Number.isFinite(coverage) && Number.isFinite(verified) && coverage <= verified && verified <= now.getTime() &&
    receipt?.channelId === 'C0C0W6B9PU6' && /^\d+\.\d+$/.test(receipt?.messageTs);
  const covered = confirmed ? parts(new Date(coverage)) : null;
  if (covered && (dateKey(covered) > date || (dateKey(covered) === date && minutes(covered) >= 1050))) return null;
  return date;
}

export async function alreadyAlerted(name, token, fetchImpl = fetch) {
  if (!token) throw new Error('Missing GitHub token');
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/caches?key=${encodeURIComponent(name)}&ref=refs%2Fheads%2Fmain&per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Alert history unavailable');
  const body = await response.json();
  if (!Array.isArray(body.actions_caches) || !Number.isInteger(body.total_count) || body.total_count !== body.actions_caches.length) throw new Error('Incomplete alert history');
  return body.actions_caches.some(a => a.key === name && a.ref === 'refs/heads/main');
}

export async function monitor(env, now = new Date(), fetchImpl = fetch) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Untrusted monitor context');
  let receipt = null;
  try { receipt = JSON.parse(env.WRAP_UP_RECEIPT || 'null'); } catch { /* Invalid receipts cannot prove delivery. */ }
  const test = env.MONITOR_MODE === 'test';
  if (test && !/^\d+$/.test(env.GITHUB_RUN_ID || '')) throw new Error('Invalid test run ID');
  const date = test ? null : missingReport(receipt, now, env.MONITOR_SINCE);
  if (!test && !date) return { status: 'healthy' };
  const name = test ? `wrap-up-monitor-test-${env.GITHUB_RUN_ID}` : `wrap-up-warning-${date}`;
  if (await alreadyAlerted(name, env.GITHUB_TOKEN, fetchImpl)) return { status: 'already-alerted' };
  const text = test
    ? `TEST — Hosted daily wrap-up monitor\nGitHub can send this warning while the laptop is off. No report failure is being claimed.\n${workflow}`
    : `CODEX — DAILY WRAP-UP MISSING\nNo confirmed delivery receipt for the ${date} 17:30 UK features and fixes report after the 18:30 deadline.\nThe laptop may be off, the report may have failed, or its delivery receipt could not sync. Missed changes remain queued for the next successful report.\n${workflow}`;
  await sendAlert(text, env.SLACK_DEPLOY_WEBHOOK_URL, fetchImpl);
  return { status: 'sent', name, date, verifiedAt: now.toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.env.VERIFY_ALERT_KEY) {
      if (!await alreadyAlerted(process.env.VERIFY_ALERT_KEY, process.env.GITHUB_TOKEN)) throw new Error('Delivery record was not saved');
      console.log('Warning delivery record verified.');
      process.exit(0);
    }
    const result = await monitor(process.env);
    if (result.status === 'sent') {
      // ponytail: Slack and cache storage are not transactional; reconcile Slack before rerunning an ambiguous failure.
      writeFileSync('wrap-up-alert.json', JSON.stringify(result));
      appendFileSync(process.env.GITHUB_OUTPUT, `cache-key=${result.name}\n`);
    }
    console.log(`Wrap-up monitor: ${result.status}`);
  } catch {
    console.error('Wrap-up monitor failed. Check GitHub access, receipt settings and Slack delivery before retrying; upstream details are omitted.');
    process.exitCode = 1;
  }
}
