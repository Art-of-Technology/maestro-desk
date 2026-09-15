import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { apiFingerprint } from '../api/scripts/build-fingerprint.mjs';

const roots = [];
const fixturePaths = ['.dockerignore', 'api/Dockerfile', 'api/package.json', 'api/bun.lock', 'api/bunfig.toml', 'api/tsconfig.json', 'api/scripts/build-fingerprint.mjs', 'api/scripts/migrate.ts', 'api/scripts/knowledge_extract.py', 'api/src/server.ts', 'db/migrations/one.sql'];
function write(root, path, content) {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), content);
}
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'respovia-fingerprint-'));
  roots.push(root);
  for (const path of fixturePaths) write(root, path, `${path}\noriginal\n`);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'respovia-fingerprint-')) throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
test('fingerprint changes with code, dependencies, migrations and build instructions', () => {
  const root = fixture(), original = apiFingerprint(root);
  expect(original).toMatch(/^[a-f0-9]{64}$/);
  for (const path of fixturePaths) {
    const before = readFileSync(resolve(root, path));
    write(root, path, 'changed');
    expect(apiFingerprint(root)).not.toBe(original);
    writeFileSync(resolve(root, path), before);
  }
});
test('frontend, tests, credentials and checkout line endings do not affect build identity', () => {
  const root = fixture(), original = apiFingerprint(root);
  write(root, 'web/index.html', 'frontend change');
  write(root, 'api/src/example.test.ts', 'test change');
  write(root, 'api/.env', 'local configuration');
  for (const path of fixturePaths) {
    const text = readFileSync(resolve(root, path), 'utf8');
    write(root, path, text.replaceAll('\n', '\r\n'));
  }
  expect(apiFingerprint(root)).toBe(original);
});
test('added and removed shipped source changes identity; missing required input fails', () => {
  const root = fixture(), original = apiFingerprint(root);
  write(root, 'api/src/extra.ts', 'new code');
  expect(apiFingerprint(root)).not.toBe(original);
  rmSync(resolve(root, 'api/src/extra.ts'));
  expect(apiFingerprint(root)).toBe(original);
  rmSync(resolve(root, 'api/bun.lock'));
  expect(() => apiFingerprint(root)).toThrow();
});
