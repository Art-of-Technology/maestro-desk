import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordActivity, activitySnapshot, validateActivity } from './local-project-activity.mjs';
import { publishLocalActivity } from './publish-local-project-activity.mjs';

const since = '2026-10-19T16:30:00.000Z', completedAt = '2026-10-20T10:00:00.000Z', through = '2026-10-20T16:30:00.000Z';
const entry = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', project: 'orbit', completedAt, title: 'feat: Save report filters' };
const feed = entries => ({ version: 1, since, through, entries });
const hostedFile = (localCoverage = {}) => JSON.stringify({ encoding: 'base64', sha: 'a'.repeat(40),
  content: Buffer.from(JSON.stringify({ version: 1, localCoverage, pending: null, lastDate: '2026-10-19', lastTestRun: null,
    receipt: { coverageThrough: since, verifiedAt: since, channelId: 'C0C0W6B9PU6', messageTs: '123.456' } })).toString('base64') });
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'project-wrap-up-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('only short, explicit summaries for registered local projects enter the feed', t => {
  const dir = temp(t);
  const saved = recordActivity('orbit', 'feat', 'Save report filters', dir, new Date(completedAt));
  recordActivity('orbit', 'fix', 'Future completion', dir, new Date('2026-10-21T10:00:00.000Z'));
  assert.deepEqual(activitySnapshot(since, dir, new Date(through)).entries, [saved]);
  for (const args of [['respovia', 'feat', 'Wrong source'], ['orbit', 'done', 'Wrong type'], ['orbit', 'fix', 'x\ny'], ['orbit', 'feat', 'x'.repeat(180)]]) {
    assert.throws(() => recordActivity(...args, dir), /Invalid/);
  }
  assert.throws(() => validateActivity(feed([entry, entry]), Date.parse(through)), /Invalid/);
  assert.throws(() => validateActivity(feed([{ ...entry, project: 'unknown' }]), Date.parse(through)), /Invalid/);
  assert.throws(() => validateActivity(feed([{ ...entry, completedAt: since }]), Date.parse(through)), /Invalid/);
  assert.throws(() => validateActivity(feed([]), Date.parse(since)), /Invalid/);
});

test('publication keeps unacknowledged records, strips extra fields and retries safely', async t => {
  const dir = temp(t), calls = [];
  writeFileSync(join(dir, entry.id + '.json'), JSON.stringify({ ...entry, secret: 'must stay local' }));
  const run = (_exe, args, options) => {
    assert.equal(options.windowsHide, true);
    calls.push({ args, options });
    if (args[0] === 'api') return hostedFile({ orbit: since });
    assert.equal(args[0], 'variable');
    assert.deepEqual(JSON.parse(options.input).entries, [entry]);
    assert.ok(!options.input.includes('secret'));
    return '';
  };
  const now = new Date(through);
  assert.equal(await publishLocalActivity(dir, run, now), 'published');
  assert.equal(calls.length, 2);
  assert.equal(await publishLocalActivity(dir, run, now), 'not-due');
  const stateBefore = readFileSync(join(dir, 'sync.json'), 'utf8');
  await assert.rejects(publishLocalActivity(dir, () => { throw new Error('offline'); }, new Date(now.getTime() + 300000)));
  assert.equal(readFileSync(join(dir, 'sync.json'), 'utf8'), stateBefore);
  assert.ok(readFileSync(join(dir, entry.id + '.json'), 'utf8').includes(entry.title));
  assert.equal(await publishLocalActivity(dir, run, new Date(now.getTime() + 300000)), 'published');
});

test('only acknowledged entries leave the upload; a snapshot excludes concurrent writes in its current millisecond', async t => {
  const dir = temp(t);
  writeFileSync(join(dir, entry.id + '.json'), JSON.stringify(entry));
  recordActivity('orbit', 'fix', 'Concurrent completion', dir, new Date(through));
  const run = (_exe, args, options) => {
    if (args[0] === 'api') {
      const file = JSON.parse(hostedFile({ orbit: completedAt }));
      const value = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      value.receipt.coverageThrough = through; value.receipt.verifiedAt = through; value.lastDate = '2026-10-20';
      file.content = Buffer.from(JSON.stringify(value)).toString('base64');
      return JSON.stringify(file);
    }
    assert.deepEqual(JSON.parse(options.input).entries, []);
    assert.equal(JSON.parse(options.input).since, completedAt);
    return '';
  };
  assert.equal(await publishLocalActivity(dir, run, new Date(through)), 'published');
  assert.equal(activitySnapshot(completedAt, dir, new Date(through)).entries.length, 1);
});

test('first publication includes queued completions even when the first attempt failed', async t => {
  const dir = temp(t);
  recordActivity('orbit', 'feat', 'Queued before initial sync', dir, new Date(completedAt));
  await assert.rejects(publishLocalActivity(dir, () => { throw new Error('offline'); }, new Date(through)));
  const run = (_exe, args, options) => {
    if (args[0] === 'api') return hostedFile();
    assert.equal(JSON.parse(options.input).entries.length, 1);
    return '';
  };
  assert.equal(await publishLocalActivity(dir, run, new Date(through)), 'published');
});

test('corrupt or future acknowledgement cannot discard queued records', async t => {
  const dir = temp(t);
  recordActivity('orbit', 'feat', 'Keep this completion', dir, new Date(completedAt));
  for (const body of ['{}', hostedFile({ orbit: '2027-01-01T00:00:00.000Z' })]) {
    let uploads = 0;
    await assert.rejects(publishLocalActivity(dir, (_exe, args) => { if (args[0] !== 'api') uploads++; return body; }, new Date(through)));
    assert.equal(uploads, 0);
  }
  writeFileSync(join(dir, entry.id + '.json'), JSON.stringify({ ...entry, completedAt: 'not-a-date' }));
  assert.throws(() => activitySnapshot(since, dir, new Date(through)), /Invalid local activity entry/);
});

test('recording and snapshots share a lock so a half-written completion cannot fall behind coverage', t => {
  const dir = temp(t), file = join(dir, 'activity.lock');
  writeFileSync(file, String(process.pid));
  assert.throws(() => recordActivity('orbit', 'fix', 'Record after snapshot', dir), /busy/);
  assert.throws(() => activitySnapshot(since, dir, new Date(through)), /busy/);
  unlinkSync(file);
  writeFileSync(file, '');
  assert.throws(() => activitySnapshot(since, dir, new Date(through)), /busy/);
  utimesSync(file, new Date(0), new Date(0));
  assert.deepEqual(activitySnapshot(since, dir, new Date(through)).entries, []);
  recordActivity('orbit', 'fix', 'Record after snapshot', dir, new Date(completedAt));
  assert.equal(activitySnapshot(since, dir, new Date(through)).entries.length, 1);
});
