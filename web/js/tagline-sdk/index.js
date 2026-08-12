// ─── Tagline SDK (What's-New announcements) ─────────────────────────────────
// Loads the third-party Tagline SDK and identifies the signed-in agent so the
// product team can publish release announcements (rendered by the SDK as a
// dismissible popup in a Shadow DOM) without per-release code changes.
//
// Named tagline-sdk, not tagline: "portal tagline" is an existing domain
// concept in this codebase (the portal header strapline) — keep grep clean.
//
// Loading contract: the script is injected dynamically, once per page load,
// only after a REAL authenticated login (initTaglineSdk is called from
// app.js's login() inside its existing `if (userId)` real-auth gate, and from
// the workspace switcher so the targeting properties track the active
// workspace). A static <script> in index.html would run before the user is
// known and fire for anonymous visitors on the auth screen. login() can run
// again within one page load (logout → sign back in), so the script injection
// is guarded but Tagline.init re-runs per identify to keep the current user.
// logout() calls resetTaglineSdk() so a signed-out shell never keeps checking
// as the previous user (the SDK has no public de-identify call, so the reset
// is ours: drop the pending id and stop gating checks through).
//
// Environments: window.RESPOVIA_ENV maps deployments to Tagline environment
// codes ('production' | 'staging' | 'dev'). Only codes registered in the
// Tagline app sync successfully — currently just 'production' (verified
// 2026-08-12; unregistered codes get {error:{code:'unknown_environment'}},
// a harmless 404 thanks to the fail-silent contract). Registering 'staging'
// in Tagline later lights up preview/staging popups with no code change.
//
// Like core/realtime.js and push/index.js, this layer is strictly optional:
// every path is fail-silent so an unreachable CDN or a blocked request can
// never break the app. The appKey below is a public identifier (safe in
// client code); Tagline's secret key is server-side only and never ships here.
import { SESSION } from '../core/state.js';
import { getWorkspaceId } from '../core/api-client.js';

const SDK_SRC = 'https://tagline.cipiti.ai/sdk/v1.js';
const APP_KEY = 'tgl_pub_eo7lZn1DFnSc3gK9YjgjTUcL';

// Same-page repaint floor for taglineCheck(): renderPage is the app's
// universal repaint primitive (filter keystrokes, settings re-renders), not
// just a navigation event, so same-page repaints re-check at most this often.
// A real page change always checks immediately.
const SAME_PAGE_CHECK_MS = 60 * 1000;

let scriptRequested = false;
let pendingUserId = null;
let identified = false;
let lastCheckPage = null;
let lastCheckAt = 0;

export function initTaglineSdk(userId) {
  if (!userId) return;  // demo personas / anonymous — never identify
  pendingUserId = userId;
  if (window.Tagline) { identify(userId); return; }
  if (scriptRequested) return;  // load in flight; onload picks up pendingUserId
  scriptRequested = true;
  const s = document.createElement('script');
  s.src = SDK_SRC;
  s.async = true;
  s.onload = () => { if (pendingUserId) identify(pendingUserId); };
  // CDN unreachable or blocked: announcements simply don't show. Un-latch the
  // guard so the next login / workspace switch retries instead of staying
  // silently dead for the whole page lifetime after one transient failure.
  s.onerror = () => {
    console.warn('[tagline-sdk] SDK script failed to load — will retry on next login/workspace switch');
    scriptRequested = false;
    s.remove();
  };
  document.head.appendChild(s);
}

// Sign-out mirror of initTaglineSdk, called from app.js logout(). The SDK
// exposes no de-identify, so this drops the pending id (a script load still
// in flight must not identify a user who already signed out) and closes the
// taglineCheck gate until the next real login identifies someone.
export function resetTaglineSdk() {
  pendingUserId = null;
  identified = false;
  // Drop the rate-limit bookkeeping too: whoever signs in next must not
  // inherit the previous session's same-page check floor.
  lastCheckPage = null;
  lastCheckAt = 0;
}

function identify(userId) {
  try {
    // Targeting attributes only — no email/name/PII, scalar values only.
    // role is the display role string ('Admin', 'Senior Agent', …);
    // workspace_id is absent for platform admins outside a workspace.
    const properties = {};
    if (SESSION?.role) properties.role = SESSION.role;
    const wsId = getWorkspaceId();
    if (wsId) properties.workspace_id = wsId;
    window.Tagline.init({
      appKey: APP_KEY,
      // api-base.js sets RESPOVIA_ENV on every host this app deploys to
      // (else-branch covers localhost/unknown with 'dev'). The fallback can
      // only trigger on the documented self-hosted preset hook (a page
      // setting RESPOVIA_API_BASE before api-base.js runs) — a production-
      // like deployment, so the integration spec's 'production' default is
      // the right label for it.
      environment: window.RESPOVIA_ENV || 'production',
      user: { id: userId, properties },
    });
    identified = true;
    // A fresh identity resets the check rate-limit: the next taglineCheck
    // fires immediately regardless of which page the previous identity last
    // checked from. (Sign-in announcements don't depend on that check at
    // all — the SDK's init() above performs its own sync and can render an
    // announcement right away; taglineCheck only covers mid-session
    // navigation after that.)
    lastCheckPage = null;
    lastCheckAt = 0;
  } catch (err) {
    // Fail-silent for the app, but not invisible to a debugger: a vendor
    // API change would otherwise die in this catch with no trace.
    console.warn('[tagline-sdk] init failed', err);
  }
}

// Called from renderPage(page) so a newly published announcement can appear
// mid-session, not only at sign-in. Gated three ways: no-op until a real
// login identified someone (and again after logout), immediate on an actual
// page change, and rate-limited on same-page repaints (see SAME_PAGE_CHECK_MS
// — some renderPage callers fire per keystroke).
export function taglineCheck(page) {
  try {
    if (!identified || !window.Tagline?.check) return;
    const now = Date.now();
    if (page === lastCheckPage && now - lastCheckAt < SAME_PAGE_CHECK_MS) return;
    lastCheckPage = page;
    lastCheckAt = now;
    window.Tagline.check();
  } catch (err) {
    console.warn('[tagline-sdk] check failed', err);
  }
}
