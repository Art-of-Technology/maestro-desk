import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { env } from './lib/env.js';
import { notifyWorkspaceRequest } from './lib/workspace-request-alert.js';

const original = { usage: env.EMAIL_USAGE_SLACK_WEBHOOK_URL, alerts: env.SLACK_ALERT_WEBHOOK_URL, base: env.APP_BASE_URL };
const originalFetch = globalThis.fetch;
const calls: { url: string; init?: RequestInit; payload: any }[] = [];
const usageWebhook = 'https://hooks.slack.com/services/usage-test';
const fallbackWebhook = 'https://hooks.slack.com/services/ops-test';

beforeEach(() => {
  calls.length = 0;
  env.EMAIL_USAGE_SLACK_WEBHOOK_URL = usageWebhook;
  env.SLACK_ALERT_WEBHOOK_URL = fallbackWebhook;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    calls.push({ url: String(input), init, payload: JSON.parse(String(init?.body)) });
    return new Response('ok');
  }) as typeof fetch;
});
afterEach(() => {
  env.EMAIL_USAGE_SLACK_WEBHOOK_URL = original.usage;
  env.SLACK_ALERT_WEBHOOK_URL = original.alerts;
  env.APP_BASE_URL = original.base;
  globalThis.fetch = originalFetch;
});

describe('workspace request Slack alert', () => {
  it('uses the existing usage destination with an action heading, amber detail card and review link', async () => {
    expect(await notifyWorkspaceRequest('Example Brand', 'Example Organisation')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(usageWebhook);
    const { payload, init } = calls[0];
    expect(payload.blocks[0].text.text).toContain('ACTION REQUIRED: Respovia workspace approval');
    expect(payload.attachments[0].color).toBe('#d97706');
    expect(payload.attachments[0].blocks[0].fields).toEqual([
      { type: 'plain_text', text: 'Brand\nExample Brand' },
      { type: 'plain_text', text: 'Organisation\nExample Organisation' },
    ]);
    const reviewUrl = new URL('/#/god', env.APP_BASE_URL).href;
    expect(payload.blocks[1].text.text).toContain(`<${reviewUrl}|Open approval requests>`);
    expect(payload.text).toContain('No workspace has been created.');
    expect(payload.text).toContain(reviewUrl);
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(payload.unfurl_links).toBe(false);
  });

  it('falls back to ops Slack and does nothing if neither destination is configured', async () => {
    env.EMAIL_USAGE_SLACK_WEBHOOK_URL = undefined;
    expect(await notifyWorkspaceRequest('Brand', 'Org')).toBe(true);
    expect(calls[0].url).toBe(fallbackWebhook);
    env.SLACK_ALERT_WEBHOOK_URL = '';
    expect(await notifyWorkspaceRequest('Brand', 'Org')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('keeps untrusted labels in bounded plain text without Slack mentions or injected links in formatted content', async () => {
    const brand = '<!channel> <https://example.test|fake>\n' + 'x'.repeat(4000);
    await notifyWorkspaceRequest(brand, '<@USER>\r\nOrg');
    const payload = calls[0].payload;
    const fields = payload.attachments[0].blocks[0].fields;
    expect(fields[0].type).toBe('plain_text');
    expect(fields[0].text.length).toBeLessThan(320);
    expect(fields[1].text).toBe('Organisation\n<@USER>  Org');
    expect(JSON.stringify(payload.blocks)).not.toContain('<!channel>');
    expect(payload.text).not.toContain('<@USER>');
    expect(payload.text).not.toContain('example.test');
    await notifyWorkspaceRequest('😀'.repeat(400), 'Org');
    expect(Array.from(calls[1].payload.attachments[0].blocks[0].fields[0].text.split('\n')[1])).toHaveLength(300);
  });

  it('contains formatting/configuration errors before delivery', async () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    env.APP_BASE_URL = 'invalid';
    try {
      expect(await notifyWorkspaceRequest('Brand', 'Org')).toBe(false);
      expect(calls).toHaveLength(0);
    } finally { warning.mockRestore(); }
  });

  for (const failure of ['HTTP', 'network']) {
    it(`contains ${failure} failures without logging credentials or Slack response bodies`, async () => {
      const warning = spyOn(console, 'warn').mockImplementation(() => {});
      globalThis.fetch = Object.assign(async (_input: any, _init?: RequestInit) => {
        if (failure === 'network') throw new Error(usageWebhook);
        return new Response('private response body', { status: 429 });
      }, { preconnect: originalFetch.preconnect });
      try {
        expect(await notifyWorkspaceRequest('Brand', 'Org')).toBe(false);
        expect(warning).toHaveBeenCalledTimes(1);
        const output = JSON.stringify(warning.mock.calls);
        expect(output).not.toContain(usageWebhook);
        expect(output).not.toContain('private response body');
      } finally { warning.mockRestore(); }
    });
  }
});
