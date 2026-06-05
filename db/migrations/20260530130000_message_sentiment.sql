-- Per-message sentiment classification. Populated asynchronously by
-- the sentiment scorer for incoming customer messages — agent and
-- internal-note rows stay null because the agent's own tone isn't
-- a signal we care about for triage.
--
-- Four buckets, deliberately coarse:
--   angry        — explicit hostility, threats, profanity directed at us
--   frustrated   — repeated friction, dissatisfaction, but not hostile
--   neutral      — informational, questions, status checks
--   positive     — thanks, compliments, resolution acknowledgements
--
-- We pick the four buckets over a continuous score so the UI can map
-- them to discrete colors and the auto-priority rule (future PR) has
-- clear thresholds.

alter table ticket_messages
  add column sentiment text
  check (sentiment is null or sentiment in ('angry', 'frustrated', 'neutral', 'positive'));
