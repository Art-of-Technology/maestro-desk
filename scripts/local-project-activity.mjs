import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import projects from './wrap-up-projects.json' with { type: 'json' };

export const activityDirectory = join(process.env.LOCALAPPDATA || process.cwd(), 'Codex', 'project-wrap-up');
export const localProjects = new Set(projects.filter(p => p.source === 'local').map(p => p.id));
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validEntry = entry => localProjects.has(entry?.project) && /^[a-f0-9-]{36}$/.test(entry?.id || '') &&
  iso(entry.completedAt) && typeof entry.title === 'string' && entry.title.length <= 180 && /^(feat|fix|other): \S[^\r\n]*$/.test(entry.title);

function locked(directory, action) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'activity.lock');
  let fd;
  try { fd = openSync(file, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Local activity is busy; retry, or inspect the lock owner if it persists');
    throw error;
  }
  // shortcut: crashed writers need manual lock recovery; never steal a lock another process may have acquired.
  try { writeFileSync(fd, String(process.pid)); return action(); }
  finally { closeSync(fd); unlinkSync(file); }
}

export function validateActivity(feed, now = Date.now()) {
  if (feed?.version !== 1 || !iso(feed.since) || !iso(feed.through) || feed.since > feed.through ||
      Date.parse(feed.through) > now || !Array.isArray(feed.entries)) throw new Error('Invalid local activity feed');
  const ids = new Set();
  for (const entry of feed.entries) {
    if (!validEntry(entry) || ids.has(entry.id) || entry.completedAt <= feed.since || entry.completedAt > feed.through) {
      throw new Error('Invalid local activity entry');
    }
    ids.add(entry.id);
  }
  return feed;
}

export function recordActivity(project, kind, title, directory = activityDirectory, now) {
  if (!localProjects.has(project) || !['feat', 'fix', 'other'].includes(kind) || typeof title !== 'string' ||
      !title.trim() || /[\r\n]/.test(title) || `${kind}: ${title}`.length > 180) throw new Error('Invalid local completion summary');
  return locked(directory, () => {
    const entry = { id: randomUUID(), project, completedAt: (now || new Date()).toISOString(), title: `${kind}: ${title}` };
    // Separate atomic files preserve completions recorded by concurrent chats.
    const file = join(directory, entry.id + '.json');
    writeFileSync(file + '.tmp', JSON.stringify(entry));
    renameSync(file + '.tmp', file);
    return entry;
  });
}

export function activitySnapshot(since, directory = activityDirectory, now = new Date()) {
  return locked(directory, () => {
    const through = now.toISOString();
    const entries = readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
      .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')))
      .map(({ id, project, completedAt, title }) => {
        const entry = { id, project, completedAt, title };
        if (!validEntry(entry)) throw new Error('Invalid local activity entry');
        return entry;
      })
      .filter(entry => entry.completedAt > since && entry.completedAt <= through)
      .sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.id.localeCompare(b.id));
    return validateActivity({ version: 1, since, through, entries }, now.getTime());
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  recordActivity(...process.argv.slice(2));
  console.log('Local project completion recorded.');
}
