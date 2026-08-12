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
// app.js's login() inside its existing `if (userId)` real-auth gate). A
// static <script> in index.html would run before the user is known and fire
// for anonymous visitors on the auth screen. login() can run again within
// one page load (logout → sign back in), so the script injection is guarded
// but Tagline.init re-runs per login to identify the current user.
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

let scriptRequested = false;
let pendingUserId = null;

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
  // CDN unreachable or blocked: announcements simply don't show.
  s.onerror = () => {};
  document.head.appendChild(s);
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
      // Set by api-base.js from the same hostname branches that pick the API
      // base, so each deployment reports its own environment to Tagline.
      environment: window.RESPOVIA_ENV || 'production',
      user: { id: userId, properties },
    });
  } catch { /* fail-silent by contract */ }
}

// Safe no-op until the SDK has loaded; called on every SPA navigation so a
// newly published announcement can appear mid-session, not only at sign-in.
export function taglineCheck() {
  try { window.Tagline?.check?.(); } catch { /* fail-silent by contract */ }
}
