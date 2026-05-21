import { z } from 'zod';

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  ANTHROPIC_API_KEY: z.string().min(20),
  // Secret Postmark passes as a query string on the inbound webhook URL:
  // https://<tunnel-host>/api/v1/webhooks/postmark/inbound?secret=<value>
  // (URL-embedded Basic Auth is rejected by Postmark's URL validator.)
  POSTMARK_INBOUND_SECRET: z.string().min(16),
  PORT: z.coerce.number().int().positive().default(3001),
});

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;
