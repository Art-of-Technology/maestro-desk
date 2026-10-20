import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sendAlert } from './deployment-alert.mjs';
import { repository, github, ukParts, dateKey, readState, saveState, initializeState } from './wrap-up-state.mjs';
import projects from './wrap-up-projects.json' with { type: 'json' };
import { validateActivity } from './local-project-activity.mjs';

async function pages(api, route) {
  const all = [];
  // ponytail: refuse more than 1,000 records; add bounded batching if the backlog reaches this ceiling.
  for (let page = 1; page <= 10; page++) {
    const rows = await api(`${route}&per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error('Incomplete source history');
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new Error('Source history exceeds the safe limit');
}

export async function collectSources(api, start, cutoff, branch = 'main') {
  const from = Date.parse(start), through = Date.parse(cutoff);
  if (!Number.isFinite(from) || !Number.isFinite(through) || from > through) throw new Error('Invalid coverage interval');
  const sources = [], known = new Set();
  let complete = false;
  for (let page = 1; page <= 10; page++) {
    const prs = await api(`pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=100&page=${page}`);
    if (!Array.isArray(prs)) throw new Error('Incomplete PR history');
    for (const pr of prs) {
      if (pr.base?.ref !== branch || !Number.isSafeInteger(pr.number) || !Number.isFinite(Date.parse(pr.updated_at))) throw new Error('Invalid PR history');
      if (Date.parse(pr.merged_at) > from && Date.parse(pr.merged_at) <= through) {
        const id = `PR${pr.number}`;
        if (!known.has(id)) sources.push({ id, title: pr.title });
        known.add(id);
      }
    }
    if (prs.length < 100 || prs.every(pr => Date.parse(pr.updated_at) < from)) { complete = true; break; }
  }
  if (!complete) throw new Error('PR history exceeds the safe limit');
  const commits = await pages(api, `commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(start)}&until=${encodeURIComponent(cutoff)}`);
  for (const commit of commits) {
    const when = Date.parse(commit.commit?.committer?.date);
    if (!/^[a-f0-9]{40}$/.test(commit.sha) || !Number.isFinite(when)) throw new Error('Invalid commit history');
    if (when <= from || when > through) continue;
    const associated = await pages(api, `commits/${commit.sha}/pulls?sort=updated`);
    // PRs cover their branch commits; exclude changes merged after this report's immutable cutoff too.
    if (associated.some(pr => pr.base?.ref === branch && pr.merged_at)) continue;
    sources.push({ id: commit.sha, title: commit.commit.message.split('\n')[0] });
  }
  return sources;
}

const plain = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[*_`~]/g, '');
function projectSection({ name, repository: projectRepository, branch, sources, observedThrough }, cutoff) {
  const groups = { features: [], fixes: [], other: [] }, seen = new Set();
  for (const source of sources) {
    if (!(projectRepository ? /^(?:PR[1-9]\d*|[a-f0-9]{40})$/ : /^[a-f0-9-]{36}$/).test(source.id) ||
        seen.has(source.id) || typeof source.title !== 'string' || !source.title.trim()) throw new Error('Invalid report source');
    seen.add(source.id);
    const title = source.title.replace(/\s+/g, ' ').trim();
    // ponytail: only explicit conventional prefixes classify changes; unfamiliar titles remain visible under Other changes.
    const type = /^(feat|fix)(?:\([^)]*\))?!?:/i.exec(title)?.[1].toLowerCase();
    const group = type === 'feat' ? 'features' : type === 'fix' ? 'fixes' : 'other';
    const label = source.id.startsWith('PR') ? source.id.replace('PR', 'PR #') : source.id.slice(0, 7);
    const path = source.id.startsWith('PR') ? 'pull/' + source.id.slice(2) : 'commit/' + source.id;
    groups[group].push('• ' + plain(title.length > 180 ? title.slice(0, 179) + '…' : title) +
      (projectRepository ? ' <https://github.com/' + projectRepository + '/' + path + '|' + label + '>' : ''));
  }
  const { features, fixes, other } = groups;
  const localStatus = !observedThrough ? 'Local updates unavailable; queued completions will be included after sync.' :
    `Local completions · synced through ${observedThrough}${Date.parse(cutoff) - Date.parse(observedThrough) > 10 * 60_000 ? ' · newer updates unavailable' : ''}`;
  return [`*${plain(name)}*`, projectRepository ? `<https://github.com/${projectRepository}|${plain(projectRepository)}> · ${plain(branch)}` : localStatus, '',
    ...(features.length ? ['✨ *New features*', ...features, ''] : []), ...(fixes.length ? ['🔧 *Fixes*', ...fixes, ''] : []),
    ...(other.length ? ['📋 *Other changes*', ...other, ''] : []),
    ...(!sources.length && (projectRepository || observedThrough) ? [projectRepository ? 'No new changes.' : 'No new completions in the synced period.', ''] : [])].join('\n');
}

export function renderSummary(reports, start, cutoff) {
  if (!reports.length || new Set(reports.map(p => p.id)).size !== reports.length || reports.some(p =>
    typeof p.name !== 'string' || !p.name.trim() || /[\r\n]/.test(p.name) ||
    (p.repository ? !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repository) || typeof p.branch !== 'string' || !p.branch || /[\r\n]/.test(p.branch) :
      p.source !== 'local' || (p.observedThrough !== null && !Number.isFinite(Date.parse(p.observedThrough)))))) {
    throw new Error('Invalid report projects');
  }
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(cutoff));
  const since = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(start));
  const count = reports.reduce((sum, p) => sum + p.sources.length, 0);
  const text = [`📦 *DAILY WRAP-UP · ${date}*`, `_GitHub changes since ${since} UK · local sync times shown per project_`, '━━━━━━━━━━━━━━━━━━━━', '',
    reports.map(p => projectSection(p, cutoff)).join('━━━━━━━━━━━━━━━━━━━━\n\n'), '━━━━━━━━━━━━━━━━━━━━',
    `*${count} updates across ${reports.length} projects*`, `_Coverage through: ${cutoff}_`].join('\n');
  if (text.length > 12000) throw new Error('Summary exceeds the Slack length limit');
  return text;
}

export async function deliverReport(state, text, cutoff, mode, runId, save, send, now = () => new Date(), localCoverage = {}) {
  if (state.value.pending) throw new Error('Previous delivery is uncertain; reconcile Slack before retrying');
  if (!/^\d+$/.test(runId)) throw new Error('Invalid workflow run ID');
  const date = dateKey(ukParts(new Date(cutoff)));
  if (mode === 'test' ? state.value.lastTestRun === runId : state.value.lastDate === date) return 'already-posted';
  state.value.pending = { cutoff, date, mode, runId, localCoverage };
  await save(state); // Commit intent before contacting Slack; failures must never trigger a blind resend.
  await send(mode === 'test' ? `TEST — Hosted report preview (coverage unchanged)\n\n${text}` : text);
  if (mode === 'test') state.value.lastTestRun = runId;
  else {
    state.value.receipt = { coverageThrough: cutoff, verifiedAt: now().toISOString(), channelId: 'C0C0W6B9PU6', transport: 'slack-webhook', runId };
    state.value.lastDate = date;
    state.value.localCoverage = { ...state.value.localCoverage, ...localCoverage };
  }
  state.value.pending = null;
  await save(state);
  return 'posted';
}

export async function runReport(env, now = new Date(), fetchImpl = fetch) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Untrusted report context');
  const mode = env.REPORT_MODE || 'send';
  if (!['init', 'preview', 'test', 'send'].includes(mode)) throw new Error('Invalid report mode');
  if (mode === 'send' && env.HOSTED_WRAP_UP_ENABLED !== 'true') return { status: 'disabled' };
  const p = ukParts(now);
  if (mode === 'send' && (['Sat', 'Sun'].includes(p.weekday) || Number(p.hour) * 60 + Number(p.minute) < 1050)) return { status: 'outside-window' };
  const api = github(env.GITHUB_TOKEN, fetchImpl);
  if (mode === 'init') {
    if (env.HOSTED_WRAP_UP_ENABLED === 'true') throw new Error('Initialize before enabling hosted delivery');
    await initializeState(api, JSON.parse(env.WRAP_UP_RECEIPT || 'null'), now.getTime());
    return { status: 'initialized' };
  }
  const state = await readState(api, now.getTime());
  console.log('Daily wrap-up stage: state loaded');
  if (state.value.pending) throw new Error('Previous delivery is uncertain; reconcile Slack before retrying');
  if (mode === 'send' && state.value.lastDate === dateKey(p)) return { status: 'already-posted' };
  if (mode === 'test' && state.value.lastTestRun === env.GITHUB_RUN_ID) return { status: 'already-posted' };
  const cutoff = now.toISOString(), start = state.value.receipt.coverageThrough;
  const reports = [], localCoverage = {};
  const activity = env.LOCAL_PROJECT_ACTIVITY ? validateActivity(JSON.parse(env.LOCAL_PROJECT_ACTIVITY), now.getTime()) : null;
  for (const project of projects) {
    if (project.source === 'local') {
      const from = state.value.localCoverage?.[project.id] || activity?.since;
      if (activity && from < activity.since) throw new Error('Incomplete local activity history');
      const sources = activity ? activity.entries.filter(e => e.project === project.id && e.completedAt > from).map(e => ({ id: e.id, title: e.title })) : [];
      const observedThrough = activity?.through || null;
      if (activity && activity.through >= from) localCoverage[project.id] = activity.through;
      reports.push({ ...project, sources, observedThrough });
      continue;
    }
    const projectApi = github(env.GITHUB_TOKEN, fetchImpl, project.repository);
    const metadata = await projectApi('');
    if (typeof metadata.default_branch !== 'string' || !metadata.default_branch) throw new Error('Invalid project default branch');
    reports.push({ ...project, branch: metadata.default_branch,
      sources: await collectSources(projectApi, start, cutoff, metadata.default_branch) });
  }
  console.log('Daily wrap-up stage: sources collected');
  const text = renderSummary(reports, start, cutoff);
  console.log('Daily wrap-up stage: summary validated');
  if (mode === 'preview') return { status: 'preview', text };
  const status = await deliverReport(state, text, cutoff, mode, env.GITHUB_RUN_ID, s => saveState(api, s), t => sendAlert(t, env.SLACK_DEPLOY_WEBHOOK_URL, fetchImpl), () => new Date(), localCoverage);
  return { status };
}

export function safeDiagnostic(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return /^(?:GitHub request failed \([1-5]\d{2}\)|Invalid report source|Summary exceeds the Slack length limit)$/.test(message)
    ? message : 'Unclassified failure; see the last completed stage';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runReport(process.env);
    if (result.text) writeFileSync('wrap-up-preview.txt', result.text);
    console.log(`Daily wrap-up: ${result.status}`);
  } catch (error) {
    console.error(`Daily wrap-up diagnostic: ${safeDiagnostic(error)}`);
    console.error('Daily wrap-up failed. Check GitHub state/history and Slack delivery. Reconcile any pending delivery before retrying; coverage was not intentionally advanced.');
    process.exitCode = 1;
  }
}
