import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sendAlert } from './deployment-alert.mjs';
import { github } from './wrap-up-state.mjs';
import { readAlertState, saveAlertState, migrateAlertState } from './security-audit-state.mjs';

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

async function recoveredScan(run, api, receipts) {
  const failures = Object.entries(receipts).filter(([name]) => name.startsWith('security-audit-failure-'));
  if (!failures.length) return null;
  failures.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
  const [key, verifiedAt] = failures[0];
  const id = Number(key.slice('security-audit-failure-'.length));
  if (!Number.isSafeInteger(id)) throw new Error('Invalid failed run ID');
  const name = `security-audit-recovery-${id}`;
  if (Object.hasOwn(receipts, name)) return null;
  const finished = Date.parse(run.updated_at);
  if (!Number.isFinite(finished) || finished < Date.parse(run.created_at) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error('Invalid recovery metadata');
  if (finished < Date.parse(verifiedAt)) return null;
  const failed = id === run.id ? run : validateRun(await api(`actions/runs/${id}`));
  if (failed.id !== id) throw new Error('Mismatched failed run');
  // shortcut: fail closed beyond 100 runs since the failure; paginate if this window grows.
  const history = await api(`actions/workflows/${file}/runs?branch=main&created=${encodeURIComponent(`>=${failed.created_at}`)}&per_page=100`);
  if (!Array.isArray(history.workflow_runs) || history.total_count !== history.workflow_runs.length) throw new Error('Incomplete recovery history');
  const runs = history.workflow_runs.map(validateRun);
  if (runs.some(item => !Number.isFinite(Date.parse(item.updated_at)) || Date.parse(item.updated_at) < Date.parse(item.created_at) || Date.parse(item.created_at) < Date.parse(failed.created_at))) throw new Error('Invalid recovery history');
  const clean = runs.find(item => item.id === run.id);
  if (!clean || clean.status !== 'completed' || clean.conclusion !== 'success' || clean.run_attempt !== run.run_attempt || clean.updated_at !== run.updated_at) return null;
  if (runs.some(item => item.status !== 'completed' || (item.id !== run.id && Date.parse(item.updated_at) >= finished))) return null;
  return {
    name, health: 'healthy',
    text: `Respovia dependency security scan recovered\nA clean scan completed after the previously reported failure. No moderate or higher vulnerabilities were found. Daily schedule health is checked separately.\nClean scan: https://github.com/${repository}/actions/runs/${run.id}\nPrevious alert: https://github.com/${repository}/actions/runs/${id}`,
  };
}

export async function inspectAudit(env, event, now, fetchImpl = fetch, receipts) {
  const api = github(env.GITHUB_TOKEN, fetchImpl);
  receipts ??= (await readAlertState(api)).value.receipts;
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const run = validateRun(event?.workflow_run);
    if (event.action !== 'completed') throw new Error('Invalid audit event');
    // A rerun may already have recovered by the time this notification is processed.
    const current = validateRun(await api(`actions/runs/${run.id}`));
    if (current.id !== run.id) throw new Error('Mismatched audit run');
    if (current.status !== 'completed') return null;
    return current.conclusion === 'success' ? recoveredScan(current, api, receipts) : failedScan(current, api);
  }
  const expected = expectedScan(now);
  const body = await api(`actions/workflows/${file}/runs?event=schedule&branch=main&created=${encodeURIComponent(`>=${new Date(expected.start).toISOString()}`)}&per_page=100`);
  if (!Array.isArray(body.workflow_runs) || !Number.isInteger(body.total_count) || body.total_count < 0 || body.total_count !== body.workflow_runs.length) throw new Error('Incomplete audit history');
  const runs = body.workflow_runs.map(validateRun);
  if (runs.some(run => run.event !== 'schedule')) throw new Error('Unexpected manual run in schedule history');
  const latest = runs.filter(run => Date.parse(run.created_at) >= expected.start && Date.parse(run.created_at) < Math.min(expected.end, now.getTime() + 1))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];
  if (latest?.status === 'completed') return latest.conclusion === 'success' ? recoveredScan(latest, api, receipts) : failedScan(latest, api);
  return {
    name: `security-audit-overdue-${expected.date}`,
    text: `Respovia daily security scan is overdue\nNo completed scheduled dependency scan for ${expected.date}, due at 06:15 UTC with two hours allowed for delays. ${latest ? 'The run has not finished.' : 'No scheduled run was found.'} Manual scans do not confirm the daily schedule is working.\n${latest ? `https://github.com/${repository}/actions/runs/${latest.id}` : workflow}`,
  };
}

export async function monitor(env, event = {}, now = new Date(), fetchImpl = fetch) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main' ||
      !['workflow_run', 'schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
      !['check', 'test', 'migrate'].includes(env.MONITOR_MODE || 'check')) throw new Error('Untrusted monitor context');
  const api = github(env.GITHUB_TOKEN, fetchImpl);
  if (env.MONITOR_MODE === 'migrate') {
    if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Migration requires manual dispatch');
    const migrated = await migrateAlertState(api);
    return { status: 'migrated', receipts: Object.keys(migrated.value.receipts).length };
  }
  const state = await readAlertState(api);
  if (state.value.pending) throw new Error('Pending security alert delivery requires reconciliation');
  let alert;
  let health = 'attention';
  if (env.MONITOR_MODE === 'test') {
    if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || !/^\d+$/.test(env.GITHUB_RUN_ID || '')) throw new Error('Invalid test context');
    alert = { name: `security-audit-test-${env.GITHUB_RUN_ID}`, text: `TEST: Respovia security scan alerts\nThis is a delivery test. No scan failure is being claimed.\n${workflow}` };
  } else {
    try { alert = await inspectAudit(env, event, now, fetchImpl, state.value.receipts); }
    catch {
      health = 'unknown';
      alert = { name: `security-audit-unknown-${now.toISOString().slice(0, 10)}`, text: `Respovia security scan status could not be checked\nGitHub audit history is unavailable or incomplete. Scan health is unknown. Check the monitor run before retrying.\nhttps://github.com/${repository}/actions/workflows/security-audit-alerts.yml` };
    }
  }
  if (!alert) return { status: 'healthy' };
  health = alert.health || health;
  if (Object.hasOwn(state.value.receipts, alert.name)) return { status: 'already-alerted', health };
  state.value.pending = { name: alert.name, startedAt: now.toISOString() };
  await saveAlertState(api, state);
  await sendAlert(alert.text, env.SLACK_DEPLOY_WEBHOOK_URL, fetchImpl);
  state.value.receipts[alert.name] = now.toISOString();
  state.value.pending = null;
  await saveAlertState(api, state);
  return { status: 'sent', name: alert.name, health, verifiedAt: now.toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const result = await monitor(process.env, event);
    if (result.health === 'unknown') appendFileSync(process.env.GITHUB_OUTPUT, 'health=unknown\n');
    console.log(`Security scan monitor: ${result.status}`);
  } catch {
    console.error('Security scan monitor failed. Check durable receipt storage and reconcile any pending Slack delivery before retrying; upstream details are omitted.');
    process.exitCode = 1;
  }
}
