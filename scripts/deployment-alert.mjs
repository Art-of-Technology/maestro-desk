import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const stages = {
  'Deploy production API': 'API deployment trigger',
  'Deploy production web': 'Web deployment trigger',
  'Post-deploy health-check': 'Production version or health check',
};
const repository = 'Art-of-Technology/maestro-desk';

export function alertText(event, context) {
  if (context.repository !== repository) return null;
  if (context.eventName === 'workflow_dispatch') {
    if (context.ref !== 'refs/heads/main') return null;
    if (!/^\d+$/.test(String(context.runId))) throw new Error('Invalid test run ID');
    return `TEST — Respovia deployment alerts\nNo deployment failure: this is a notification test.\nhttps://github.com/${repository}/actions/runs/${context.runId}`;
  }
  const run = event.workflow_run;
  if (context.eventName !== 'workflow_run' || !run ||
      event.action !== 'completed' || run.head_branch !== 'main' ||
      run.head_repository?.full_name !== repository ||
      !['push', 'workflow_dispatch'].includes(run.event) ||
      !Object.hasOwn(stages, run.name) ||
      !['failure', 'timed_out'].includes(run.conclusion)) return null;
  if (!Number.isSafeInteger(run.id) || run.id <= 0 || !/^[a-f0-9]{40}$/.test(run.head_sha)) {
    throw new Error('Invalid deployment run metadata');
  }
  return `Respovia deployment needs attention\n${stages[run.name]} ${run.conclusion === 'timed_out' ? 'timed out' : 'failed'}.\nCommit: ${run.head_sha.slice(0, 12)}\nhttps://github.com/${repository}/actions/runs/${run.id}\nCheck the failed run before retrying or rolling back.`;
}

export async function sendAlert(text, url, fetchImpl = fetch) {
  url = url?.trim();
  if (!/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+$/.test(url || '')) {
    throw new Error('SLACK_DEPLOY_WEBHOOK_URL is missing or invalid');
  }
  // No automatic retry: a timeout may mean Slack accepted the message already.
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
  } catch { throw new Error('Slack delivery could not be confirmed'); }
  if (!response.ok || (await response.text()).trim() !== 'ok') {
    throw new Error(`Slack rejected the alert (HTTP ${response.status})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const text = alertText(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), {
      eventName: process.env.GITHUB_EVENT_NAME, repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF, runId: process.env.GITHUB_RUN_ID,
    });
    if (text) {
      await sendAlert(text, process.env.SLACK_DEPLOY_WEBHOOK_URL);
      console.log('Deployment alert delivered to Slack.');
    } else console.log('No deployment alert needed.');
  } catch {
    console.error('Deployment alert failed. Check the Slack webhook secret and connectivity; no response details are logged.');
    process.exitCode = 1;
  }
}
