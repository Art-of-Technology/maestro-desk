import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAudit } from './dependency-audit-result.mjs';

test('audit classification requires a valid report consistent with its exit status', () => {
  const result = (report, status) => ({ stdout: JSON.stringify(report), status });
  assert.equal(classifyAudit(result({}, 0)), 'clean');
  assert.equal(classifyAudit(result({ pkg: [{ id: 123, severity: 'low' }] }, 0)), 'clean');
  for (const severity of ['moderate', 'high', 'critical']) {
    assert.equal(classifyAudit(result({ pkg: [{ id: 123, severity }] }, 1)), 'findings');
    assert.equal(classifyAudit(result({ pkg: [{ id: 123, severity }] }, 0)), 'error');
  }
  for (const report of [null, [], 'error', { error: 'unavailable' }, { pkg: [] }, { pkg: [{ severity: 'high' }] }, { pkg: [{ id: 1, severity: 'unknown' }] }]) {
    assert.equal(classifyAudit(result(report, 1)), 'error');
  }
  for (const bad of [result({}, 1), { stdout: '', status: 1 }, { stdout: '<html>', status: 0 },
    { stdout: '{}', status: 0, error: new Error('timeout') }, { stdout: '{}', status: 0, signal: 'SIGTERM' }, result({}, null), result({}, 2)]) {
    assert.equal(classifyAudit(bad), 'error');
  }
});
