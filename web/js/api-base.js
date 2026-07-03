// Runtime API-base selection. No bundler/build step, so we pick the API host at
// runtime by hostname. Loaded as a CLASSIC script (not a module) in the <head>
// of both index.html (agent SPA) and portal.html (public portal), BEFORE the
// app entry, so window.MAESTRO_API_BASE is set before anything reads it.
//
// Extracted from the pages' formerly-inline <script> blocks so the SPA can ship
// a strict Content-Security-Policy (script-src 'self', no 'unsafe-inline').
//
// Only known prod/staging hosts point at a deployed API; everything else
// (localhost dev, Vercel PR previews with hashed hostnames) leaves the value
// unset, so each page's `window.MAESTRO_API_BASE || 'http://localhost:3001'`
// fallback keeps previews from ever silently hitting production. A workspace
// self-hosting the portal under its own domain may set the global before this
// runs — the guard below won't clobber it.
//
// KEEP IN SYNC: every API host mapped below must also appear in the connect-src
// of web/vercel.json's Content-Security-Policy, or the browser CSP will block
// API calls from that host. (connect-src additionally lists api.anthropic.com
// for the direct-from-browser AI calls in js/ai/client.js.)
(function () {
  if (window.MAESTRO_API_BASE) return;
  var h = location.hostname;
  if (/^(desk|help)\.maestro-desk\.com$/.test(h)) {
    window.MAESTRO_API_BASE = 'https://api.maestro-desk.com';
  } else if (h === 'maestro-desk-jodi-1420s-projects.vercel.app') {
    // Interim live testing on Vercel's *.vercel.app URL (no custom domain yet).
    window.MAESTRO_API_BASE = 'https://maestro-desk-zjkl.vercel.app';
  } else if (h === 'maestro-desk-git-staging-jodi-1420s-projects.vercel.app') {
    // STAGING (rehearsal env). ⚠ CONFIRM these hostnames against the real Vercel
    // branch-deploy URLs for the `staging` branch; update if the slug differs.
    window.MAESTRO_API_BASE = 'https://maestro-desk-zjkl-git-staging-jodi-1420s-projects.vercel.app';
  }
})();
