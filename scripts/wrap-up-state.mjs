export const repository = 'Art-of-Technology/maestro-desk';
export const stateBranch = 'codex-wrap-up-state';
const statePath = 'contents/wrap-up-state.json';
export const ukParts = date => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(date).map(p => [p.type, p.value]));
export const dateKey = p => `${p.year}-${p.month}-${p.day}`;

export function validReceipt(receipt, now = Date.now()) {
  const coverage = Date.parse(receipt?.coverageThrough), verified = Date.parse(receipt?.verifiedAt);
  return Number.isFinite(coverage) && Number.isFinite(verified) && coverage <= verified && verified <= now &&
    receipt?.channelId === 'C0C0W6B9PU6' && (/^\d+\.\d+$/.test(receipt?.messageTs || '') ||
      (receipt?.transport === 'slack-webhook' && /^\d+$/.test(receipt?.runId || '')));
}

export function github(token, fetchImpl = fetch) {
  return async (route, method = 'GET', body) => {
    if (!token) throw new Error('Missing GitHub token');
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub request failed (${response.status})`), { status: response.status });
    return response.json();
  };
}

export async function readState(api, now = Date.now()) {
  const file = await api(`${statePath}?ref=${stateBranch}`);
  if (file.encoding !== 'base64' || !/^[a-f0-9]{40}$/.test(file.sha)) throw new Error('Invalid state file');
  const value = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  if (value.version !== 1 || !validReceipt(value.receipt, now) ||
      !Object.hasOwn(value, 'pending') || !Object.hasOwn(value, 'lastDate') || !Object.hasOwn(value, 'lastTestRun')) throw new Error('Invalid report state');
  if ((value.lastDate !== null && value.lastDate !== dateKey(ukParts(new Date(value.receipt.coverageThrough)))) ||
      (value.lastTestRun !== null && !/^\d+$/.test(value.lastTestRun))) throw new Error('Invalid report delivery markers');
  if (value.pending !== null && (!['send', 'test'].includes(value.pending?.mode) || !/^\d+$/.test(value.pending?.runId || '') ||
      !Number.isFinite(Date.parse(value.pending?.cutoff)) || Date.parse(value.pending.cutoff) < Date.parse(value.receipt.coverageThrough) ||
      value.pending.date !== dateKey(ukParts(new Date(value.pending.cutoff))))) throw new Error('Invalid pending delivery');
  return { sha: file.sha, value };
}

export async function saveState(api, state) {
  const result = await api(statePath, 'PUT', { branch: stateBranch, ...(state.sha ? { sha: state.sha } : {}),
    message: 'Update confirmed wrap-up coverage [skip ci]',
    content: Buffer.from(JSON.stringify(state.value, null, 2)).toString('base64') });
  if (!/^[a-f0-9]{40}$/.test(result.content?.sha)) throw new Error('State save was not confirmed');
  state.sha = result.content.sha;
}

export async function initializeState(api, receipt, now) {
  if (!validReceipt(receipt, now)) throw new Error('A confirmed starting receipt is required');
  try { return await readState(api, now); } catch (error) { if (error.status !== 404) throw error; }
  try { await api(`git/ref/heads/${stateBranch}`); }
  catch (error) {
    if (error.status !== 404) throw error;
    const main = await api('git/ref/heads/main');
    await api('git/refs', 'POST', { ref: `refs/heads/${stateBranch}`, sha: main.object.sha });
  }
  const p = ukParts(new Date(receipt.coverageThrough));
  const state = { value: { version: 1, receipt, pending: null,
    lastDate: Number(p.hour) * 60 + Number(p.minute) >= 1050 ? dateKey(p) : null, lastTestRun: null } };
  await saveState(api, state);
  return state;
}
