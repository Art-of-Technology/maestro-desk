-- Confidence-gated auto-reply.
--
-- Two new per-workspace knobs:
--
--   auto_reply_min_confidence smallint  — minimum triage confidence (0-100)
--     for auto-reply to fire. NULL disables auto-reply entirely for the
--     workspace. Use a fairly high threshold (80+); the AI gets to talk to
--     real customers without human review, so the bar should be high.
--
--   auto_reply_categories text[]        — whitelist of category keys where
--     auto-reply is allowed. Empty array = no auto-reply. Carve-out lets
--     a workspace enable auto-reply for safe categories (password resets,
--     order status) while keeping high-stakes categories (GDPR, refunds
--     above £N) human-only.

alter table workspaces
  add column auto_reply_min_confidence smallint
    check (auto_reply_min_confidence is null
           or (auto_reply_min_confidence between 0 and 100)),
  add column auto_reply_categories text[] not null default '{}';

-- Enable on the demo workspace with a moderately conservative default.
-- GDPR is deliberately omitted — statutory deadlines need a human review.
-- Bumping min_confidence to 85 means roughly the top quartile of triages
-- get auto-replied; the rest go to the human queue.
update workspaces
  set auto_reply_min_confidence = 85,
      auto_reply_categories = array['Account', 'Billing', 'Technical', 'Feature']
  where id = '00000000-0000-0000-0000-000000000001';
