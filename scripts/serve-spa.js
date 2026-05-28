// Static file server for the SPA. Serves repo root over HTTP so ES modules load.
import { file } from 'bun';
import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const PORT = 5173;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    const abs = normalize(join(ROOT, path));
    if (!abs.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return new Response(`Not found: ${path}`, { status: 404 });
    }
    return new Response(file(abs));
  },
});

console.log(`SPA serving on http://localhost:${PORT}`);
