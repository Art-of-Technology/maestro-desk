import { test, expect, mock } from 'bun:test';
let workspace = 'brand-a', jwt = 'session', response, fail = false, release;
globalThis.window = { escHtml: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  escAttr: s => String(s).replaceAll('"', '&quot;').replaceAll('<', '&lt;') };
mock.module('../web/js/core/api-client.js', () => ({ getWorkspaceId: () => workspace, getJwt: () => jwt,
  apiGet: async () => { const result = response; if (release) await new Promise(resolve => { release = resolve; }); if (fail) throw Error('offline'); return result; } }));
const statuses = await import('../web/js/tickets/status-options.js');
const choice = (key, extra = {}) => ({ key, label: key, base_key: 'resolved', is_active: true, send_survey: false, ...extra });

test('brand status metadata escapes labels, preserves retired selections, and resets on identity changes', async () => {
  response = { statuses: [choice('custom-1', { label: '<img src=x>', is_active: false }), choice('custom-2')] };
  await statuses.loadStatusOptions();
  expect(statuses.statusLabel({ status: 'resolved', statusOption: 'custom-1' })).toBe('<img src=x>');
  const html = statuses.statusSelectOptions('custom-1');
  expect(html).toContain('&lt;img src=x&gt;'); expect(html).toContain('disabled'); expect(html).toContain('(retired)');
  expect(statuses.statusOptions()).toHaveLength(1);
  workspace = 'brand-b'; expect(statuses.statusOptions()).toEqual([]); expect(statuses.statusOptionsState().ready).toBe(false);
  response = { statuses: [choice('brand-b')] }; await statuses.loadStatusOptions();
  jwt = 'another-user'; expect(statuses.statusOptions()).toEqual([]);
});

test('late responses from another brand cannot overwrite current choices, and load failures disable selection', async () => {
  workspace = 'old-brand'; response = { statuses: [choice('old-brand')] }; release = true;
  const pending = statuses.loadStatusOptions(); const finish = release; release = null;
  workspace = 'new-brand'; response = { statuses: [choice('new-brand')] }; await statuses.loadStatusOptions();
  finish(); await pending;
  expect(statuses.statusOptions().map(s => s.key)).toEqual(['new-brand']);
  fail = true; await statuses.loadStatusOptions(true);
  expect(statuses.statusOptionsState().ready).toBe(false); expect(statuses.statusOptionsState().error).toContain('Reload');
  fail = false;
});

test('normalizes legacy closure defaults and rejects malformed reason settings', async () => {
  workspace = 'reason-brand'; response = { statuses: [choice('closed', { base_key: 'closed' })] };
  await statuses.loadStatusOptions();
  expect(statuses.statusChoice('closed').reason_required).toBe(true);
  expect(statuses.statusChoice('closed').reasons.map(r => r.key)).toContain('spam');
  response = { statuses: [choice('bad', { reason_required: 'yes', reasons: [] })] };
  await statuses.loadStatusOptions(true); expect(statuses.statusOptionsState().ready).toBe(false);
  response = { statuses: [choice('bad', { reasons: [null] })] };
  await statuses.loadStatusOptions(true); expect(statuses.statusOptionsState().ready).toBe(false);
});
