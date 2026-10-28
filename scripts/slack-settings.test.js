import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'bun:test';

const source = readFileSync(new URL('../web/js/settings/index.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('async function saveSlackIntegration()'), source.indexOf('async function deleteSlackIntegration()'));
const testHandler = source.slice(source.indexOf('async function testSlackIntegration()'), source.indexOf('async function deleteSlackIntegration()'));

test('Slack test alerts block duplicate clicks, enforce permission and restore the button after failure', async () => {
  for (const mode of ['success', 'failure', 'member']) {
    const button = { disabled: false };
    const msg = { textContent: '', style: {} };
    let calls = 0;
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const context = { can: () => mode !== 'member', document: { getElementById: id => id === 'slack-test' ? button : msg },
      apiPost: async (path, body) => {
        calls++;
        expect(path).toBe('/api/v1/integrations/slack/test');
        expect(Object.keys(body)).toHaveLength(0);
        await pending;
        if (mode === 'failure') throw new Error('Slack rejected the test alert.');
      },
    };
    const running = runInNewContext(testHandler + '\ntestSlackIntegration()', context);
    await runInNewContext(testHandler + '\ntestSlackIntegration()', context);
    expect(calls).toBe(mode === 'member' ? 0 : 1);
    finish();
    await running;
    expect(button.disabled).toBe(false);
    if (mode !== 'member') expect(msg.textContent).toContain(mode === 'success' ? 'Slack accepted' : 'Slack rejected');
  }
});

test('Slack settings omit an unchanged secret and clear a replacement after saving', async () => {
  for (const mode of ['existing', 'new', 'replacement', 'member', 'failed']) {
    const elements = Object.fromEntries(['slack-url', 'slack-channel', 'slack-active', 'slack-bot-token', 'slack-signing-secret', 'slack-msg', 'slack-evt-ticket.created'].map(id => [id, { value: '', checked: true, style: {} }]));
    const replacement = 'https://hooks.slack.com/services/test/replacement';
    if (['replacement', 'failed'].includes(mode)) elements['slack-url'].value = replacement;
    const calls = [];
    const context = { can: () => mode !== 'member', window: { isAdmin: () => mode !== 'member' }, document: { getElementById: id => elements[id] },
      SLACK_INTEGRATION: mode === 'new' ? null : { has_webhook: true }, SLACK_EVENTS: [{ k: 'ticket.created' }],
      apiPut: async (_path, body) => { calls.push(body); if (mode === 'failed') throw new Error('Offline'); },
      apiGet: async () => ({ integration: { has_webhook: true } }), renderPage() {},
    };
    await runInNewContext(handler + '\nsaveSlackIntegration()', context);
    expect(calls.length).toBe(['member', 'new'].includes(mode) ? 0 : 1);
    if (mode === 'existing') expect(calls[0].webhook_url).toBeUndefined();
    if (mode === 'replacement') { expect(calls[0].webhook_url).toBe(replacement); expect(elements['slack-url'].value).toBe(''); }
    if (mode === 'new') expect(elements['slack-msg'].textContent).toContain('required');
    if (mode === 'failed') { expect(elements['slack-msg'].textContent).toBe('Offline'); expect(elements['slack-url'].value).toBe(replacement); }
  }
});
