import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Only build inputs: never environment files, installed dependencies or web/.
const required = [
  '.dockerignore', 'api/Dockerfile', 'api/package.json', 'api/bun.lock',
  'api/bunfig.toml', 'api/tsconfig.json', 'api/scripts/build-fingerprint.mjs',
  'api/scripts/migrate.ts', 'api/scripts/knowledge_extract.py',
];
export function apiFingerprint(root) {
  const paths = [...required];
  function walk(path) {
    for (const entry of readdirSync(resolve(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && !entry.name.endsWith('.test.ts')) paths.push(child);
      else if (!entry.isFile()) throw new Error(`Unsupported build input: ${child}`);
    }
  }
  walk('api/src');
  walk('db/migrations');
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    // All inputs are text; normalize checkout line endings across Windows/Linux.
    const content = readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
    hash.update(path + '\0' + Buffer.byteLength(content) + '\0');
    hash.update(content);
  }
  return hash.digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  console.log(JSON.stringify({ buildFingerprint: apiFingerprint(root) }));
}
