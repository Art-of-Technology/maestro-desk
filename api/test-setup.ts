// Bun test preload (see bunfig.toml) — runs once before any test file loads.
//
// env.ts validates the environment at module load (`Env.parse(process.env)`)
// and THROWS on missing required vars, which leaves its `env` export
// uninitialized. Several test files import code that transitively loads env.ts,
// so whichever file bun happens to evaluate first must already have these set
// — otherwise the first load throws and every later access fails with
// "Cannot access 'env' before initialization". File order differs by OS
// (local vs CI), so setting them here, before anything loads, makes the suite
// deterministic regardless of order.
//
// All placeholders: the DB connection is lazy (no socket opened) and no test
// hits the network. `||=` so a real value from the environment still wins.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';
// postmark-outbound.test.ts needs Postmark to read as "configured" at env-parse
// time (it stubs fetch, so nothing is actually sent). env is parsed once, so
// these must be present before the first load — same reason as above.
process.env.POSTMARK_SERVER_TOKEN ||= 'test-server-token';
process.env.POSTMARK_OUTBOUND_FROM ||= 'support@maestro.test';
