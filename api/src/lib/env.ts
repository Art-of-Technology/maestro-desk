import { z } from 'zod';

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  ANTHROPIC_API_KEY: z.string().min(20),
  PORT: z.coerce.number().int().positive().default(3001),
});

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;
