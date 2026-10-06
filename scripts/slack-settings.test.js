import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'bun:test';

const source = readFileSync(new URL('../web/js/settings/index.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('async function saveSlackIntegration()'), source.indexOf('async function deleteSlackIntegration()'));

test('Slack settings omit an unchanged secret and clear a replacement after saving', async () => {
  for (const mode of ['existing', 'new', 'replacement', 'member', 'failed']) {
    const elements = Object.fromEntries(['slack-url', 'slack-channel', 'slack-active', 'slack-bot-token', 'slack-signing-secret', 'slack-msg', 'slack-evt-ticket.created'].map(id => [id, { value: '', checked: true, style: {} }]));
    const replacement = 'https://hooks.slack.com/services/test/replacement';
    if (['replacement', 'failed'].includes(mode)) elements['slack-url'].value = replacement;
    const calls = [];
    const context = { window: { isAdmin: () => mode !== 'member' }, document: { getElementById: id => elements[id] },
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
