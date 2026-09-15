import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBuildFingerprint } from './lib/build-info.js';

test('reads only a valid generated fingerprint; missing dev marker is explicit', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'respovia-build-info-'));
  const path = resolve(root, 'build-info.json');
  try {
    expect(readBuildFingerprint(pathToFileURL(path))).toBeNull();
    writeFileSync(path, JSON.stringify({ buildFingerprint: 'a'.repeat(64) }));
    expect(readBuildFingerprint(pathToFileURL(path))).toBe('a'.repeat(64));
    for (const content of ['not JSON', '{}', '{"buildFingerprint":"invalid"}']) {
      writeFileSync(path, content);
      expect(() => readBuildFingerprint(pathToFileURL(path))).toThrow();
    }
  } finally {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'respovia-build-info-')) throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
