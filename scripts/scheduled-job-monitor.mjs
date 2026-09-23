import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sendAlert } from './deployment-alert.mjs';

const repository = 'Art-of-Technology/maestro-desk';
const hour = 3_600_000;
export const deadlines = { 'knowledge-refresh': hour, 'email-usage': 3 * hour, 'webhook-retry': 30 * hour, retention: 30 * hour };

export function overdueJobs(runs, now, activatedAt) {
  if (!Number.isFinite(now) || !Number.isFinite(activatedAt) || activatedAt > now) throw new Error('Invalid monitor dates');
  return Object.entries(deadlines).flatMap(([job, limit]) => {
    const successes = runs.filter(run => run.display_title === `Scheduled job - ${job}` &&
      run.event === 'schedule' && run.head_branch === 'main' && run.status === 'completed' && run.conclusion === 'success')
      .map(run => Date.parse(run.created_at)).filter(date => Number.isFinite(date) && date <= now);
    const last = successes.length ? Math.max(...successes) : null;
    // First installation: old runs have no job label. Give each job one full
    // deadline to establish its first labelled success; never guess which ran.
    if (now - (last ?? activatedAt) <= limit) return [];
    return [{ job, lastSuccess: last === null ? null : new Date(last).toISOString(), hours: limit / hour }];
  });
}

export async function readHistory(token, now, fetchImpl = fetch) {
  const base = `https://api.github.com/repos/${repository}/actions/workflows/`;
  async function get(path) {
    const response = await fetchImpl(base + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!response.ok) throw new Error('GitHub history unavailable');
    return response.json();
  }
  const monitor = await get('scheduled-job-monitor.yml');
  const activatedAt = Date.parse(monitor.created_at);
  if (!Number.isFinite(activatedAt)) throw new Error('Monitor activation date unavailable');
  const runs = [];
  const since = encodeURIComponent(`>=${new Date(now - 31 * hour).toISOString()}`);
  // GitHub caps filtered run searches at 1,000 results. Refuse incomplete history.
  for (let page = 1; page <= 10; page++) {
    const body = await get(`cron-jobs.yml/runs?event=schedule&branch=main&created=${since}&per_page=100&page=${page}`);
    if (!Array.isArray(body.workflow_runs) || !Number.isInteger(body.total_count) || body.total_count > 1000) throw new Error('Incomplete job history');
    runs.push(...body.workflow_runs);
    if (runs.length >= body.total_count) return { runs, activatedAt };
    if (body.workflow_runs.length === 0) throw new Error('Incomplete job history');
  }
  throw new Error('Incomplete job history');
}

export function overdueText(jobs) {
  return `Respovia scheduled jobs need attention\n${jobs.map(({ job, lastSuccess, hours }) =>
    `${job}: no successful scheduled run within ${hours} hours. Last success: ${lastSuccess ?? 'none since monitoring began'}.`).join('\n')}\nhttps://github.com/${repository}/actions/workflows/cron-jobs.yml\nCheck the run history before retrying maintenance jobs.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let text;
  try {
    if (!process.env.GITHUB_TOKEN) throw new Error('Missing GitHub token');
    const now = Date.now();
    const { runs, activatedAt } = await readHistory(process.env.GITHUB_TOKEN, now);
    const overdue = overdueJobs(runs, now, activatedAt);
    if (overdue.length) text = overdueText(overdue);
    console.log(`${overdue.length} scheduled jobs overdue.`);
  } catch {
    text = `Respovia scheduled-job monitoring could not check run history.\nhttps://github.com/${repository}/actions/workflows/scheduled-job-monitor.yml\nCheck GitHub access and the monitor logs. Job health is unknown.`;
    process.exitCode = 1;
  }
  if (text) {
    try { await sendAlert(text, process.env.SLACK_DEPLOY_WEBHOOK_URL); }
    catch { console.error('Scheduled-job alert delivery could not be confirmed.'); process.exitCode = 1; }
  }
}
