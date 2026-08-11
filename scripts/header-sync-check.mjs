// Guard: web/vercel.json (Vercel hosting headers) and web/nginx.conf (the
// self-hosted image's headers) must declare IDENTICAL values for every header
// vercel.json sets. The two files serve the same SPA on different hosts during
// the Vercel→Dokploy transition; the likely failure is editing the CSP
// connect-src in one file only, which silently blocks the other host's API
// calls in production with no build-time signal. nginx may carry EXTRA headers
// (e.g. Cache-Control, which Vercel adds platform-side, not via vercel.json).
//
// Run: bun scripts/header-sync-check.mjs   (CI: ci.yml guards job)
import { readFileSync } from 'node:fs';

const vercel = JSON.parse(readFileSync('web/vercel.json', 'utf8'));
const nginx = readFileSync('web/nginx.conf', 'utf8');

const wanted = new Map();
for (const rule of vercel.headers ?? []) {
  for (const h of rule.headers ?? []) wanted.set(h.key.toLowerCase(), h.value);
}
if (wanted.size === 0) {
  console.error('header-sync: no headers found in web/vercel.json — the parse is broken, refusing to pass');
  process.exit(1);
}

const declared = new Map();
// add_header <Name> "<value>" always;  — the config convention (server-level,
// double-quoted, `always`). A header added in any other shape won't be seen
// here, which is fine: the guard's contract is the vercel.json set.
for (const m of nginx.matchAll(/^\s*add_header\s+(\S+)\s+"((?:[^"\\]|\\.)*)"\s+always;/gm)) {
  declared.set(m[1].toLowerCase(), m[2]);
}

let failed = false;
for (const [key, value] of wanted) {
  const got = declared.get(key);
  if (got === undefined) {
    console.error(`header-sync: web/nginx.conf is MISSING header "${key}" (present in web/vercel.json)`);
    failed = true;
  } else if (got !== value) {
    console.error(`header-sync: header "${key}" differs\n  vercel.json: ${value}\n  nginx.conf:  ${got}`);
    failed = true;
  }
}

if (failed) {
  console.error('\nheader-sync: web/vercel.json and web/nginx.conf must be edited together.');
  process.exit(1);
}
console.log(`OK — ${wanted.size} headers in web/vercel.json all match web/nginx.conf.`);
