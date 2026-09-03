// Versioned source of truth for the Dokploy cron schedules — the repo-side
// answer to "the panel is hand-entered state that silently vanishes if the
// app is recreated". Idempotent upsert: run it after creating/recreating the
// respovia-api application and the schedules below exist with exactly these
// definitions; run it again anytime to reconcile drift.
//
//   DOKPLOY_URL=https://paas.weez.boo DOKPLOY_TOKEN=... \
//     node deploy/dokploy/provision-schedules.mjs <applicationId>
//
// The commands exec INSIDE the API container (scheduleType: application), so
// they need no CRON_SECRET and no HTTP — see api/src/cron-run.ts.
//
// STATUS 2026-09-03: these schedules have failed every run since late August
// ("Container not found for application … make sure the service is running" —
// the panel cannot exec into the container). The scheduler of record is now
// .github/workflows/cron-jobs.yml, which calls the same jobs over the
// CRON_SECRET-gated HTTP endpoints. Keep this file as the desired Dokploy
// state for when an owner fixes the panel; both mechanisms are idempotent.

const BASE = process.env.DOKPLOY_URL;
const TOKEN = process.env.DOKPLOY_TOKEN;
const APP_ID = process.argv[2];
if (!BASE || !TOKEN || !APP_ID) {
  console.error('usage: DOKPLOY_URL=... DOKPLOY_TOKEN=... node provision-schedules.mjs <applicationId>');
  process.exit(2);
}

// THE schedule set. Change here, then re-run — never hand-edit the panel.
const SCHEDULES = [
  {
    name: 'webhook-retry',
    description: 'Webhook retry sweep (api/src/cron-run.ts webhook-retry)',
    cronExpression: '0 3 * * *',
    command: 'node --import tsx src/cron-run.ts webhook-retry',
  },
  {
    name: 'retention',
    description: 'Retention purge + audit-verify + GDPR/object + email-domain sweeps (api/src/cron-run.ts retention)',
    cronExpression: '0 4 * * *',
    command: 'node --import tsx src/cron-run.ts retention',
  },
];

async function api(path, init) {
  const res = await fetch(`${BASE}/api/${path}`, {
    ...init,
    headers: { 'x-api-key': TOKEN, 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

const existing = await api(`schedule.list?id=${encodeURIComponent(APP_ID)}&scheduleType=application`, { method: 'GET' });
// Fail loudly on an unexpected response shape: silently treating it as "no
// schedules" would CREATE duplicates next to the ones we failed to see.
if (!Array.isArray(existing)) {
  console.error(`schedule.list returned a non-array — refusing to upsert against unknown state:\n${JSON.stringify(existing).slice(0, 500)}`);
  process.exit(1);
}
for (const want of SCHEDULES) {
  const base = {
    ...want,
    scheduleType: 'application',
    applicationId: APP_ID,
    shellType: 'sh',
    enabled: true,
  };
  const found = (Array.isArray(existing) ? existing : []).find((s) => s.name === want.name);
  if (found) {
    await api('schedule.update', { method: 'POST', body: JSON.stringify({ ...base, scheduleId: found.scheduleId }) });
    console.log(`updated  ${want.name} (${want.cronExpression}): ${want.command}`);
  } else {
    await api('schedule.create', { method: 'POST', body: JSON.stringify(base) });
    console.log(`created  ${want.name} (${want.cronExpression}): ${want.command}`);
  }
}
console.log('done — schedules match this file.');
