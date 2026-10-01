// Run with Node and Docker; probes the real image for inherited log leaks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { get } from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = `respovia-log-check-${randomUUID()}`;
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, 0, result.stderr || 'docker command failed');
  return result.stdout + (args[0] === 'logs' ? result.stderr : '');
};
const secret = 'private-person@example.test_secret-token';
try {
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::80',
    '-v', `${root}web/nginx.conf:/etc/nginx/conf.d/default.conf:ro`,
    '-v', `${root}web:/usr/share/nginx/html:ro`, 'nginx:1.29-alpine');
  const port = JSON.parse(docker('inspect', name))[0].NetworkSettings.Ports['80/tcp'][0].HostPort;
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await fetch(base, { signal: AbortSignal.timeout(1000) }); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert(ready, 'nginx did not start');
  for (const [path, host, expected] of [
    ['/', 'app.respovia.com', 200], [`/${secret}`, 'app.respovia.com', 404],
    ['/', 'respovia.com', 308],
  ]) {
    const status = await new Promise((resolve, reject) => {
      get(`${base}${path}?reset_token=${secret}`, {
        timeout: 3000,
        headers: { Host: host, Referer: `https://example.test/${secret}`, 'User-Agent': secret },
      }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
        response.on('error', reject);
      }).on('error', reject).on('timeout', function () { this.destroy(new Error('nginx request timed out')); });
    });
    assert.equal(status, expected);
  }
  const logs = docker('logs', name);
  assert(!logs.includes(secret), 'private sentinel leaked into nginx logs');
  for (const status of [200, 404, 308]) assert(logs.includes(`status=${status} `), `missing ${status} diagnostic`);
  assert(logs.split('\n').filter(line => line.startsWith('status=')).every(line => /^status=\d{3} duration=[\d.]+ bytes=\d+\r?$/.test(line)));
  console.log('nginx privacy smoke passed: 200, 404 and 308, no request data logged');
} finally {
  try { docker('rm', '-f', name); } catch { /* no container if startup failed */ }
}
