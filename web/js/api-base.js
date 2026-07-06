// Runtime API-base selection. No bundler/build step, so we pick the API host at
// runtime by hostname. Loaded as a CLASSIC script (not a module) in the <head>
// of both index.html (agent SPA) and portal.html (public portal), BEFORE the
// app entry, so window.MAESTRO_API_BASE is set before anything reads it.
//
// Extracted from the pages' formerly-inline <script> blocks so the SPA can ship
// a strict Content-Security-Policy (script-src 'self', no 'unsafe-inline').
//
// Known prod/staging hosts point at their deployed API; Vercel PR previews
// (branch/hashed hostnames under this team's *.vercel.app namespace) point at
// the STAGING API so features are verifiable from the preview link — never at
// production. Anything else (localhost dev, unknown hosts) leaves the value
// unset, so each page's `window.MAESTRO_API_BASE || 'http://localhost:3001'`
// fallback still applies. A workspace self-hosting the portal under its own
// domain may set the global before this runs — the guard below won't clobber it.
//
// KEEP IN SYNC: every API host mapped below must also appear in the connect-src
// of web/vercel.json's Content-Security-Policy, or the browser CSP will block
// API calls from that host. (connect-src additionally lists api.anthropic.com
// for the direct-from-browser AI calls in js/ai/client.js.)
(function () {
  if (window.MAESTRO_API_BASE) return;
  // The staging API also backs every PR-preview SPA (one API deploy per
  // `staging` branch push). KEEP IN SYNC with api/src/lib/env.ts's
  // PREVIEW_SPA_ORIGIN_RE — that server regex must accept exactly the preview
  // hosts this branch captures, or previews get CORS-blocked.
  var STAGING_API = 'https://maestro-desk-zjkl-git-staging-jodi-1420s-projects.vercel.app';
  var h = location.hostname;
  if (/^(desk|help)\.maestro-desk\.com$/.test(h)) {
    window.MAESTRO_API_BASE = 'https://api.maestro-desk.com';
  } else if (h === 'maestro-desk-jodi-1420s-projects.vercel.app') {
    // Interim live testing on Vercel's *.vercel.app URL (no custom domain yet).
    window.MAESTRO_API_BASE = 'https://maestro-desk-zjkl.vercel.app';
  } else if (/^maestro-desk-git-(?!main-)[a-z0-9-]+-jodi-1420s-projects\.vercel\.app$/.test(h)) {
    // STAGING (`git-staging`) and every PR-preview branch deploy → the staging
    // API + staging DB, never prod. The `git-` marker is REQUIRED and `git-main`
    // excluded so PRODUCTION deployment URLs don't match: Vercel also gives prod
    // a `maestro-desk-<hash>-…` deployment URL and a `git-main` alias, and
    // matching those would silently point production UI at staging. The staging
    // API runs the `staging` branch, so PRs that change API code still need
    // local verification; SPA-only PRs are fully verifiable on the preview link.
    window.MAESTRO_API_BASE = STAGING_API;
  }
})();
