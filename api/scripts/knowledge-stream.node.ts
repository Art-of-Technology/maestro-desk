// Node production-runtime regression: force an accented character to cross
// subprocess pipe writes, then compare the entire large extracted document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractKnowledge } from '../src/lib/knowledge-import.js';

test(
  'preserves UTF-8 across subprocess chunks',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'knowledge-stream-test-'));
    const previousPath = process.env.PATH;
    const body = 'aprobación retiro € '.repeat(8000);
    const program = `#!/usr/bin/env node
const bytes = Buffer.from(${JSON.stringify(JSON.stringify({ body, warnings: [] }))});
const split = bytes.indexOf(0xc3) + 1;
process.stdout.write(bytes.subarray(0, split));
setTimeout(() => process.stdout.write(bytes.subarray(split)), 100);
`;
    try {
      await writeFile(path.join(directory, 'python3'), program, { mode: 0o700 });
      process.env.PATH = directory + path.delimiter + previousPath;
      const result = await extractKnowledge(Buffer.from('<p>Fixture</p>'), 'html');
      assert.ok(result.body === body, 'The full extracted document must match the Unicode fixture');
      assert.equal(result.body.includes('\uFFFD'), false);
    } finally {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
