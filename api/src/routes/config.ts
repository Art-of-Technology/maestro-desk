import { Hono } from 'hono';
import { env } from '../lib/env.ts';

export const config = new Hono();

// GET /api/v1/config — public bootstrap config for the SPA. No auth.
//
// Returns the Supabase project URL + anon key so the SPA can call
// supabase.auth.* without hardcoding them at build time. Both values are
// safe to expose — the anon key is meant to be public (RLS gates access),
// and the project URL is in every PostgREST request anyway.
//
// What this does NOT include: service-role key, Postmark tokens, the
// Anthropic key. Those stay server-side.
config.get('/', (c) =>
  c.json({
    supabase_url: env.SUPABASE_URL,
    supabase_anon_key: env.SUPABASE_ANON_KEY,
  }),
);
