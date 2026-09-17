import { expect, mock, test } from 'bun:test';

const actions = {};
const calls = [];
globalThis.window = globalThis;
globalThis.window.escHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
globalThis.window.escAttr = globalThis.window.escHtml;
globalThis.document = { body: { dataset: { currentPage: 'not-reports' } } };

mock.module('../web/js/core/api-client.js', () => ({
  getJwt: () => 'fixture-token',
  getWorkspaceId: () => 'fixture-workspace',
  apiGet: async path => {
    calls.push(path);
    return {
      range: '30d',
      summary: { attempts: 20, failures: 5, successes: 15, providerFailures: 1, indeterminate: 4, affectedTickets: 3, failureRate: 25, recordingSince: '2026-09-01T00:00:00Z' },
      reasons: [{ code: 'unknown_language', count: 4 }, { code: 'provider_error', count: 1 }],
      trend: [
        { bucket: '2026-09-01T00:00:00Z', attempts: 10, failures: 0 },
        { bucket: '2026-09-02T00:00:00Z', attempts: 10, failures: 5 },
      ],
      trendTruncated: false,
    };
  },
}));
mock.module('../web/js/core/router.js', () => ({ renderPage() {} }));
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions: handlers => Object.assign(actions, handlers) }));

const { renderLanguageDetectionFailures } = await import('../web/js/reports/language-detection.js');

test('renders a bounded reliability summary, pulse and recurring reasons', async () => {
  expect(renderLanguageDetectionFailures('30d')).toContain('Loading detection reliability');
  await new Promise(resolve => setTimeout(resolve, 0));
  const html = renderLanguageDetectionFailures('30d');
  expect(calls).toEqual(['/api/v1/reports/language-detection?range=30d']);
  expect(html).toContain('<strong>25%</strong>');
  expect(html).toContain('5</strong><span>failed or unclear');
  expect(html).toContain('Not enough language evidence');
  expect(html).toContain('AI provider unavailable');
  expect(html).toContain('detection-pulse-cell ok');
  expect(html).toContain('detection-pulse-cell fail');
  expect(html).not.toContain('provider request');
  expect(actions['detectionFailures.retry']).toBeFunction();
});
