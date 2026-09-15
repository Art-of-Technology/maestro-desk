import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export function publicFrontendFiles(files) {
  return files.filter(path => path.startsWith('web/')
    && !path.split('/').some(part => part.startsWith('.'))
    && !['web/Dockerfile', 'web/nginx.conf', 'web/vercel.json'].includes(path));
}

// Compare bytes, including binary assets. Each pass has one shared deadline.
export async function verifyFrontend(base, files, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const failures = [];
  const deadline = AbortSignal.timeout(timeoutMs);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (next < files.length) {
      const { path, content } = files[next++];
      try {
        const url = new URL(path.split('/').map(encodeURIComponent).join('/'), base.endsWith('/') ? base : base + '/');
        url.searchParams.set('deploy_check', Date.now().toString());
        const response = await fetchImpl(url, {
          headers: { 'Cache-Control': 'no-cache' },
          signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]),
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const actual = Buffer.from(await response.arrayBuffer());
        if (!actual.equals(content)) throw new Error('content differs from expected version');
      } catch (error) {
        failures.push(`${path}: ${error.message}`);
      }
    }
  }));
  return failures;
}

export async function waitForFrontend(base, files, { attempts = 16, delayMs = 15000, verify = verifyFrontend, pause = sleep, log = console.log } = {}) {
  if (!files.length) throw new Error('No frontend files selected for verification');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const failures = await verify(base, files);
    if (!failures.length) {
      log(`Frontend verified: all ${files.length} files match the expected version.`);
      return;
    }
    log(`Frontend pending (${attempt}/${attempts}): ${failures.length} files unavailable or different.\n${failures.slice(0, 8).join('\n')}`);
    if (attempt < attempts) await pause(delayMs);
  }
  throw new Error('Frontend deployment not verified. Production may still serve an older version; inspect Dokploy deployment status. API health alone does not prove a deployment completed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const paths = execFileSync('git', ['ls-files', '-z', 'web'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    const files = publicFrontendFiles(paths).map(path => ({ path: path.slice(4), content: readFileSync(path) }));
    await waitForFrontend(process.env.SPA_BASE || 'https://app.respovia.com', files);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
