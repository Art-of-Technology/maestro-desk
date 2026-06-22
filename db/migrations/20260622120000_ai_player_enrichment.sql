-- Per-workspace toggle for sending live player account data (balance, KYC,
-- VIP, country) to the LLM during AI triage. Defaults to FALSE — the safe,
-- data-minimising posture (owner decision 2026-06-22): the AI still triages on
-- the ticket subject + thread, just without live player-account enrichment. A
-- brand opts in explicitly once the Anthropic DPA is confirmed for it.
--
-- AML risk is ALWAYS excluded regardless of this flag (see lib/player-context.ts).

alter table workspaces
  add column if not exists ai_player_enrichment boolean not null default false;
