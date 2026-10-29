import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { github } from './wrap-up-state.mjs';
import { readAlertState, saveAlertState } from './security-audit-state.mjs';

const repository = 'https://github.com/Art-of-Technology/maestro-desk';

export async function reconcileAlert(api, choose, log = console.log, now = () => new Date()) {
  const reviewed = await readAlertState(api);
  const pending = reviewed.value.pending;
  if (!pending) {
    log('No pending security alert delivery. Nothing changed.');
    return { status: 'no-pending' };
  }
  log(`Pending alert: ${pending.name}\nSend started (UTC): ${pending.startedAt}`);
  log(`Monitor history: ${repository}/actions/workflows/security-audit-alerts.yml`);
  log(`Receipt history: ${repository}/commits/security-audit-state/security-audit-receipts.json`);
  const run = /^security-audit-(failure|recovery|test)-(\d+)$/.exec(pending.name);
  if (run) log(`${run[1] === 'recovery' ? 'Previously failed scan' : 'Related run'}: ${repository}/actions/runs/${run[2]}`);
  log('Check Slack delivery at https://app.slack.com using the timestamp and linked monitor run. An absent receipt alone does not prove the message was unsent.');
  log('Confirmed sent records delivery and clears pending. Confirmed unsent clears pending so a later monitor may retry. Leave unresolved if unsure. This command sends no message.');
  const choice = await choose();
  if (!['confirmed sent', 'confirmed unsent'].includes(choice)) {
    log('Left unresolved. Nothing changed.');
    return { status: 'unresolved' };
  }
  const active = await api('actions/workflows/security-audit-alerts.yml/runs?branch=main&status=in_progress&per_page=100');
  if (!Array.isArray(active.workflow_runs) || active.total_count !== active.workflow_runs.length) throw new Error('Invalid monitor history');
  if (active.total_count !== 0) {
    log('A security alert monitor is running. Nothing changed; wait for it to finish and review again.');
    return { status: 'busy' };
  }
  const current = await readAlertState(api);
  if (current.sha !== reviewed.sha) {
    log('Receipt state changed during review. Nothing changed; run the command again to review the current state.');
    return { status: 'state-changed' };
  }
  if (choice === 'confirmed sent') {
    const confirmedAt = now().toISOString();
    if (Date.parse(confirmedAt) < Date.parse(pending.startedAt)) throw new Error('Invalid confirmation time');
    current.value.receipts[pending.name] = confirmedAt;
  }
  current.value.pending = null;
  await saveAlertState(api, current);
  log(choice === 'confirmed sent' ? 'Delivery recorded and pending cleared. Saved state verified.' : 'Pending cleared without recording delivery. A later monitor may retry. Saved state verified.');
  return { status: choice === 'confirmed sent' ? 'confirmed-sent' : 'confirmed-unsent' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('This command takes no arguments');
    const token = process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const result = await reconcileAlert(github(token), async () => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return 'leave unresolved';
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try { return (await input.question('Type "confirmed sent", "confirmed unsent", or press Enter to leave unresolved: ')).trim(); }
      finally { input.close(); }
    });
    if (['busy', 'state-changed'].includes(result.status)) process.exitCode = 1;
  } catch {
    console.error('Reconciliation did not complete. Check GitHub authentication, monitor activity and durable receipt history before retrying. No message was sent by this command.');
    process.exitCode = 1;
  }
}
