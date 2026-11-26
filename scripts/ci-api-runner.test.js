import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const block = workflow.split('      - name: Tests (hermetic + DB-backed isolation suite)')[1]
  .split('        env:')[0].split('        run: |')[1]
  .split('\n').map(line => line.replace(/^          /, '')).join('\n');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

function run(files, failing = '') {
  const result = spawnSync(bash, ['-e', '-c', `
    git() { printf '%s' "$FILES" | tr '|' '\\0'; }
    bun() { printf 'TEST:%s\\n' "$2"; test "$2" != "$FAILING"; }
    ${block}
  `], { encoding: 'utf8', env: { ...process.env, FILES: files, FAILING: failing } });
  assert.ifError(result.error);
  return result;
}

test('CI runs every matching file, including spaces, after a failure', () => {
  const files = 'src/a.test.ts|src/not-a-test.ts|src/with spaces.spec.jsx|src/last_test.js|';
  const result = run(files, './src/a.test.ts');
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.match(/^TEST:.*$/gm), [
    'TEST:./src/a.test.ts', 'TEST:./src/with spaces.spec.jsx', 'TEST:./src/last_test.js',
  ]);
  assert.match(result.stdout, /Ran 3 test files/);
  assert.equal(run(files).status, 0);
});

test('CI fails when discovery finds no test files', () => {
  assert.equal(run('').status, 1);
});
