import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Local verification still checks the requested checkout. Actions only checks main's current commit.
export async function isCurrentDeployment({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  if (env.GITHUB_ACTIONS !== 'true') return true;
  if (env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
      || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '') || !env.GITHUB_TOKEN) {
    throw new Error('Cannot verify deployment: missing or invalid GitHub main-branch context.');
  }
  const response = await fetchImpl(`${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/git/ref/heads/main`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Cannot verify current main commit: GitHub HTTP ${response.status}.`);
  const sha = (await response.json()).object?.sha;
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('GitHub returned an invalid main commit.');
  const current = sha === env.GITHUB_SHA;
  if (!current) log(`Skipping superseded deployment check: ${env.GITHUB_SHA} has been replaced by ${sha} on main.`);
  return current;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const current = await isCurrentDeployment();
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `current=${current}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
