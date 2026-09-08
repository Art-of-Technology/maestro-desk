-- Serialize survey sends across API instances without holding a DB connection
-- during mail delivery. A crashed sender's claim expires after ten minutes.
ALTER TABLE tickets ADD COLUMN csat_send_claim uuid;
ALTER TABLE tickets ADD COLUMN csat_send_started_at timestamptz;

-- The old browser stamped requests without sending or creating a survey token.
-- Clear only those false markers; this migration does not send any mail.
UPDATE tickets SET csat_requested_at = NULL
WHERE csat_requested_at IS NOT NULL AND csat_token IS NULL
  AND csat_submitted_at IS NULL AND csat_score IS NULL AND csat_stars IS NULL;
