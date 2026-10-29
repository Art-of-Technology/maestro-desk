const branch = 'security-audit-state';
const path = 'contents/security-audit-receipts.json';
const validName = name => /^security-audit-(?:(?:failure|recovery|test)-[1-9]\d*|(?:overdue|unknown)-\d{4}-\d{2}-\d{2})$/.test(name);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function validate(value) {
  if (value?.version !== 1 || !value.receipts || typeof value.receipts !== 'object' || Array.isArray(value.receipts) ||
      Object.entries(value.receipts).some(([name, time]) => !validName(name) || !validTime(time)) ||
      !Object.hasOwn(value, 'pending') || (value.pending !== null &&
        (!validName(value.pending?.name) || !validTime(value.pending?.startedAt) || Object.hasOwn(value.receipts, value.pending.name)))) {
    throw new Error('Invalid security alert state');
  }
}

export async function readAlertState(api) {
  const file = await api(`${path}?ref=${branch}`);
  if (file.encoding !== 'base64' || !/^[a-f0-9]{40}$/.test(file.sha)) throw new Error('Invalid security alert state file');
  const value = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  validate(value);
  return { sha: file.sha, value };
}

export async function saveAlertState(api, state) {
  validate(state.value);
  const result = await api(path, 'PUT', {
    branch, ...(state.sha ? { sha: state.sha } : {}), message: 'Update security alert delivery state [skip ci]',
    content: Buffer.from(JSON.stringify(state.value, null, 2)).toString('base64'),
  });
  const saved = await readAlertState(api);
  if (saved.sha !== result.content?.sha || JSON.stringify(saved.value) !== JSON.stringify(state.value)) throw new Error('Security alert state save was not verified');
  state.sha = saved.sha;
}

export async function migrateAlertState(api) {
  try { return await readAlertState(api); } catch (error) { if (error.status !== 404) throw error; }
  const receipts = {};
  let total, seen = 0;
  const ids = new Set();
  for (let page = 1; ; page++) {
    const body = await api(`actions/caches?key=security-audit-&ref=refs%2Fheads%2Fmain&per_page=100&page=${page}`);
    if (!Array.isArray(body.actions_caches) || !Number.isSafeInteger(body.total_count) || body.total_count < 0 ||
        (total !== undefined && total !== body.total_count)) throw new Error('Incomplete legacy alert receipts');
    total = body.total_count;
    for (const cache of body.actions_caches) {
      if (!Number.isSafeInteger(cache.id) || cache.id < 1 || ids.has(cache.id)) throw new Error('Invalid legacy cache page');
      ids.add(cache.id);
      if (cache.ref !== 'refs/heads/main' || !cache.key?.startsWith('security-audit-')) continue;
      if (!validName(cache.key) || !Number.isFinite(Date.parse(cache.created_at))) throw new Error('Invalid legacy alert receipt');
      const time = new Date(cache.created_at).toISOString();
      if (!Object.hasOwn(receipts, cache.key) || time < receipts[cache.key]) receipts[cache.key] = time;
    }
    seen += body.actions_caches.length;
    if (seen === total) break;
    if (seen > total || body.actions_caches.length === 0) throw new Error('Incomplete legacy alert receipts');
  }
  try { await api(`git/ref/heads/${branch}`); }
  catch (error) {
    if (error.status !== 404) throw error;
    const main = await api('git/ref/heads/main');
    if (!/^[a-f0-9]{40}$/.test(main.object?.sha)) throw new Error('Invalid main reference');
    await api('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: main.object.sha });
  }
  const state = { value: { version: 1, receipts, pending: null } };
  await saveAlertState(api, state);
  return state;
}
