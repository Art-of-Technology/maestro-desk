import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAudit, severityCounts } from './dependency-audit-result.mjs';

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

test('severity counts deduplicate advisory IDs across packages and exclude low severity', () => {
  const report = { first: [{ id: 1, severity: 'critical' }, { id: 2, severity: 'high' }, { id: 3, severity: 'moderate' }, { id: 4, severity: 'low' }],
    second: [{ id: 1, severity: 'critical' }, { id: 5, severity: 'high' }] };
  assert.deepEqual(severityCounts({ stdout: JSON.stringify(report), status: 1 }), { critical: 1, high: 2, moderate: 1 });
  report.second.push({ id: 3, severity: 'high' });
  assert.equal(severityCounts({ stdout: JSON.stringify(report), status: 1 }), null);
  for (const result of [{ stdout: '{}', status: 0 }, { stdout: '{}', status: 1 }, { stdout: 'invalid', status: 1 }]) {
    assert.equal(severityCounts(result), null);
  }
});
