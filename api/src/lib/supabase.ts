import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.ts';

// Service-role client: bypasses RLS. Use ONLY for trusted server-side work
// (workspace lookups, system tasks, signup, anything that needs cross-
// workspace access like the god UI). Never expose its key to the frontend
// or include it in error responses.
export const supabaseAdmin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// User-scoped client: forwards the caller's JWT on every request so RLS
// sees their auth.uid() and the custom claims injected by the Custom
// Access Token Hook (workspace_ids, is_platform_admin). Use this for
// route handlers we've migrated to RLS-enforced scoping — the user JWT
// carries the workspace membership list, RLS denies anything outside
// it, and the API still scopes to the active workspace via
// .eq('workspace_id', workspaceId) on top.
//
// Required env: SUPABASE_ANON_KEY (the publishable key — not service
// role). The anon key is the "I'm an authenticated end-user" key;
// supabase-js attaches it as apikey, the user JWT as Authorization.
//
// PREREQUISITE for any route using this: the Custom Access Token Hook
// must be enabled in Supabase Dashboard → Authentication → Hooks → set
// to public.custom_access_token_hook. Without it, JWTs lack the
// workspace_ids claim and the new RLS policies (is_workspace_member)
// deny everything.
export function userClient(jwt: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}
