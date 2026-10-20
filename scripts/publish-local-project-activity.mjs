import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activityDirectory, activitySnapshot, localProjects } from './local-project-activity.mjs';
import { repository, readState } from './wrap-up-state.mjs';

export async function publishLocalActivity(directory = activityDirectory, run = execFileSync, now = new Date()) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'sync.json');
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (Date.parse(state.lastPublishedAt) + 5 * 60_000 > now.getTime()) return 'not-due';
  const gh = (args, input) => run('C:/Program Files/GitHub CLI/gh.exe', args,
    { windowsHide: true, timeout: 20_000, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  const hosted = (await readState(route => JSON.parse(gh(['api', `repos/${repository}/${route}`])), now.getTime())).value;
  // Only confirmed delivery may remove events from the published backlog; local originals stay intact.
  const since = [...localProjects].map(id => hosted.localCoverage?.[id] || '1970-01-01T00:00:00.000Z').sort()[0];
  // Exclude the current millisecond so a concurrent writer cannot fall behind this snapshot's watermark.
  const feed = activitySnapshot(since, directory, new Date(now.getTime() - 1));
  const body = JSON.stringify(feed);
  if (Buffer.byteLength(body) > 40000) throw new Error('Local activity exceeds the GitHub variable limit; no entries were discarded');
  gh(['variable', 'set', 'CODEX_LOCAL_PROJECT_ACTIVITY', '--repo', repository], body);
  state.lastPublishedAt = now.toISOString();
  writeFileSync(file + '.tmp', JSON.stringify(state));
  renameSync(file + '.tmp', file);
  return 'published';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(`Local project activity: ${await publishLocalActivity()}`); }
  catch { console.error('Local project activity sync failed; queued completions were retained.'); process.exitCode = 1; }
}
