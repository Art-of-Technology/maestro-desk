import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sendAlert } from './deployment-alert.mjs';
import { alreadyAlerted } from './wrap-up-monitor.mjs';
import { github } from './wrap-up-state.mjs';

const repository = 'Art-of-Technology/maestro-desk';
const file = 'dependency-security-audit.yml';
const workflow = `https://github.com/${repository}/actions/workflows/${file}`;
const day = 86_400_000;

export function expectedScan(now) {
  const today = now.toISOString().slice(0, 10);
  const start = Date.parse(`${today}T06:15:00Z`) - (now < new Date(`${today}T08:15:00Z`) ? day : 0);
  return { date: new Date(start).toISOString().slice(0, 10), start, end: start + day };
}

function validateRun(run) {
  if (!Number.isSafeInteger(run?.id) || run.id <= 0 ||
      run.name !== 'Dependency security audit' || run.path !== `.github/workflows/${file}` ||
      run.head_branch !== 'main' || run.head_repository?.full_name !== repository ||
      !['schedule', 'workflow_dispatch'].includes(run.event) ||
      !Number.isFinite(Date.parse(run.created_at)) || !['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(run.status) ||
      (run.status === 'completed' && !['success', 'failure', 'timed_out', 'cancelled', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure'].includes(run.conclusion))) throw new Error('Invalid audit history');
  return run;
}

async function failedScan(run, api) {
  let detail = 'The scan outcome is unknown. Check the run for details before retrying.';
  if (run.conclusion === 'timed_out' || run.conclusion === 'cancelled') {
    detail = `The dependency scan ${run.conclusion === 'timed_out' ? 'timed out' : 'was cancelled'}. It did not confirm a clean result.`;
  } else if (Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0) {
    try {
      const body = await api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
      if (!Array.isArray(body.jobs) || body.total_count !== 1 || body.jobs.length !== 1) throw new Error('Incomplete audit jobs');
      const job = body.jobs[0];
      if (job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.name !== 'Audit current main dependencies' ||
          job.status !== 'completed' || !Array.isArray(job.steps)) throw new Error('Invalid audit job');
      const findings = job.steps.filter(step => step.name === 'Dependency audit found vulnerabilities' && step.conclusion === 'failure');
      const errors = job.steps.filter(step => step.name === 'Dependency audit could not complete' && step.conclusion === 'failure');
      if (findings.length === 1 && errors.length === 0) {
        detail = 'The dependency scan found moderate or higher vulnerabilities. Update the affected dependencies and run the scan again.';
        const summaries = job.steps.filter(step => typeof step.name === 'string' && step.name.startsWith('Dependency audit counts:'));
        if (summaries.length === 1 && summaries[0].status === 'completed' && summaries[0].conclusion === 'success') {
          const match = /^Dependency audit counts: critical=(0|[1-9]\d*) high=(0|[1-9]\d*) moderate=(0|[1-9]\d*)$/.exec(summaries[0].name);
          const counts = match?.slice(1).map(Number);
          if (counts?.every(Number.isSafeInteger) && Number.isSafeInteger(counts.reduce((a, b) => a + b, 0)) && counts.some(count => count > 0)) {
            detail += `\nUnique advisories: ${counts[0]} critical, ${counts[1]} high, ${counts[2]} moderate.`;
          }
        }
      }
      if (errors.length === 1 && findings.length === 0) detail = 'The dependency scan could not complete. Check setup, registry access and scanner output before retrying. Vulnerability status is unknown.';
    } catch { /* Keep the unknown outcome when job results cannot be verified. */ }
  }
  return {
    name: `security-audit-failure-${run.id}`,
    text: `Respovia security scan needs attention (${run.conclusion})\n${detail}\nhttps://github.com/${repository}/actions/runs/${run.id}`,
  };
}

export async function inspectAudit(env, event, now, fetchImpl = fetch) {
  const api = github(env.GITHUB_TOKEN, fetchImpl);
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const run = validateRun(event?.workflow_run);
    if (event.action !== 'completed') throw new Error('Invalid audit event');
    // A rerun may already have recovered by the time this notification is processed.
    const current = validateRun(await api(`actions/runs/${run.id}`));
    if (current.id !== run.id) throw new Error('Mismatched audit run');
    return current.status === 'completed' && current.conclusion !== 'success' ? failedScan(current, api) : null;
  }
  const expected = expectedScan(now);
  const body = await api(`actions/workflows/${file}/runs?event=schedule&branch=main&created=${encodeURIComponent(`>=${new Date(expected.start).toISOString()}`)}&per_page=100`);
  if (!Array.isArray(body.workflow_runs) || !Number.isInteger(body.total_count) || body.total_count < 0 || body.total_count !== body.workflow_runs.length) throw new Error('Incomplete audit history');
  const runs = body.workflow_runs.map(validateRun);
  if (runs.some(run => run.event !== 'schedule')) throw new Error('Unexpected manual run in schedule history');
  const latest = runs.filter(run => Date.parse(run.created_at) >= expected.start && Date.parse(run.created_at) < Math.min(expected.end, now.getTime() + 1))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];
  if (latest?.status === 'completed') return latest.conclusion === 'success' ? null : failedScan(latest, api);
  return {
    name: `security-audit-overdue-${expected.date}`,
    text: `Respovia daily security scan is overdue\nNo completed scheduled dependency scan for ${expected.date}, due at 06:15 UTC with two hours allowed for delays. ${latest ? 'The run has not finished.' : 'No scheduled run was found.'} Manual scans do not confirm the daily schedule is working.\n${latest ? `https://github.com/${repository}/actions/runs/${latest.id}` : workflow}`,
  };
}

export async function monitor(env, event = {}, now = new Date(), fetchImpl = fetch) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main' ||
      !['workflow_run', 'schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
      !['check', 'test'].includes(env.MONITOR_MODE || 'check')) throw new Error('Untrusted monitor context');
  let alert;
  let health = 'attention';
  if (env.MONITOR_MODE === 'test') {
    if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || !/^\d+$/.test(env.GITHUB_RUN_ID || '')) throw new Error('Invalid test context');
    alert = { name: `security-audit-test-${env.GITHUB_RUN_ID}`, text: `TEST: Respovia security scan alerts\nThis is a delivery test. No scan failure is being claimed.\n${workflow}` };
  } else {
    try { alert = await inspectAudit(env, event, now, fetchImpl); }
    catch {
      health = 'unknown';
      alert = { name: `security-audit-unknown-${now.toISOString().slice(0, 10)}`, text: `Respovia security scan status could not be checked\nGitHub audit history is unavailable or incomplete. Scan health is unknown. Check the monitor run before retrying.\nhttps://github.com/${repository}/actions/workflows/security-audit-alerts.yml` };
    }
  }
  if (!alert) return { status: 'healthy' };
  if (await alreadyAlerted(alert.name, env.GITHUB_TOKEN, fetchImpl)) return { status: 'already-alerted', health };
  await sendAlert(alert.text, env.SLACK_DEPLOY_WEBHOOK_URL, fetchImpl);
  return { status: 'sent', name: alert.name, health, verifiedAt: now.toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.env.VERIFY_ALERT_KEY) {
      if (!await alreadyAlerted(process.env.VERIFY_ALERT_KEY, process.env.GITHUB_TOKEN)) throw new Error('Delivery record was not saved');
      console.log('Security scan alert delivery record verified.');
    } else {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      const result = await monitor(process.env, event);
      if (result.status === 'sent') {
        // shortcut: Slack and cache saves are not transactional; reconcile delivery before retrying an ambiguous failure.
        writeFileSync('security-audit-alert.json', JSON.stringify(result));
        appendFileSync(process.env.GITHUB_OUTPUT, `cache-key=${result.name}\n`);
      }
      if (result.health === 'unknown') appendFileSync(process.env.GITHUB_OUTPUT, 'health=unknown\n');
      console.log(`Security scan monitor: ${result.status}`);
    }
  } catch {
    console.error('Security scan monitor failed. Check GitHub access and Slack delivery before retrying; upstream details are omitted.');
    process.exitCode = 1;
  }
}
