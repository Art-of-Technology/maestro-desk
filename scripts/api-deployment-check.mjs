import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { apiFingerprint } from '../api/scripts/build-fingerprint.mjs';

export async function verifyApi(base, expected, fetchImpl = fetch) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Expected API fingerprint is invalid');
  // Both responses must identify the expected build; readiness must belong to it.
  for (const path of ['api/v1/health', 'api/v1/health/ready']) {
    const url = new URL(path, base.endsWith('/') ? base : base + '/');
    url.searchParams.set('deploy_check', Date.now().toString());
    const response = await fetchImpl(url, {
      headers: { 'Cache-Control': 'no-cache' }, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    const body = await response.json();
    if (body.ok !== true || body.buildFingerprint !== expected) {
      throw new Error(`${path}: API is not ready on the expected build`);
    }
  }
}

export async function waitForApi(base, expected, { attempts = 16, delayMs = 15000, verify = verifyApi, pause = sleep, log = console.log } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await verify(base, expected);
      log('API build fingerprint matches and database readiness passed.');
      return;
    } catch (error) {
      log(`API deployment pending (${attempt}/${attempts}): ${error.message}`);
      if (attempt < attempts) await pause(delayMs);
    }
  }
  throw new Error('API deployment not verified. Check Dokploy build and migration logs; a healthy previous container is not proof of deployment.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await waitForApi(process.env.API_BASE || 'https://api.respovia.com', apiFingerprint(fileURLToPath(new URL('../', import.meta.url))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
