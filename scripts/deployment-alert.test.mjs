import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertText, sendAlert } from './deployment-alert.mjs';

const repo = 'Art-of-Technology/maestro-desk';
const context = { repository: repo, eventName: 'workflow_run' };
const event = { action: 'completed', workflow_run: {
  name: 'Deploy production API', head_branch: 'main', head_repository: { full_name: repo },
  event: 'push', conclusion: 'failure', id: 123, head_sha: 'a'.repeat(40),
  display_title: 'private text <!channel>', html_url: 'https://untrusted.example',
} };

test('all three deployment stages alert on failures and timeouts using safe metadata', () => {
  for (const name of ['Deploy production API', 'Deploy production web', 'Post-deploy health-check']) {
    for (const conclusion of ['failure', 'timed_out']) {
      const text = alertText({ ...event, workflow_run: { ...event.workflow_run, name, conclusion } }, context);
      assert.match(text, /Respovia deployment needs attention/);
      assert.match(text, /https:\/\/github.com\/Art-of-Technology\/maestro-desk\/actions\/runs\/123/);
      assert.doesNotMatch(text, /private|channel|untrusted/);
    }
  }
});
test('success, cancellation, skipped, foreign branches/repositories and unrelated workflows do not alert', () => {
  for (const change of [
    ...['success', 'cancelled', 'skipped'].map(conclusion => ({ conclusion })),
    { head_branch: 'feature' }, { name: 'CI' }, { event: 'pull_request' },
    { head_repository: { full_name: 'other/repo' } },
  ]) assert.equal(alertText({ ...event, workflow_run: { ...event.workflow_run, ...change } }, context), null);
  assert.equal(alertText({ ...event, action: 'requested' }, context), null);
});
test('manual notification is labelled as a test and restricted to main', () => {
  const manual = { ...context, eventName: 'workflow_dispatch', ref: 'refs/heads/main', runId: 456 };
  assert.match(alertText({}, manual), /^TEST.*\nNo deployment failure:/);
  assert.equal(alertText({}, { ...manual, ref: 'refs/heads/feature' }), null);
});
test('Slack delivery uses a bounded POST and rejects unsafe URLs and failure responses', async () => {
  const url = 'https://hooks.slack.com/services/test/token';
  await sendAlert('test', url, async (target, options) => {
    assert.equal(target, url);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    assert.equal(JSON.parse(options.body).text, 'test');
    return new Response('ok');
  });
  await assert.rejects(sendAlert('test', 'https://other.example'), /missing or invalid/);
  await assert.rejects(sendAlert('test', url, async () => new Response('private-detail', { status: 403 })), /HTTP 403/);
  await assert.rejects(sendAlert('test', url, async () => { throw new Error(url); }), { message: 'Slack delivery could not be confirmed' });
});
