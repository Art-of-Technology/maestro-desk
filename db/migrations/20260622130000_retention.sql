-- Per-workspace data-retention window (owner decision 2026-06-22): resolved
-- tickets (and their PII-bearing children, via FK cascade) are purged once they
-- pass the window, measured from resolved_at.
--
-- Default 1825 days (5 years) — a common iGaming AML/KYC floor, and short enough
-- to satisfy GDPR's storage-limitation principle. A brand can raise/lower it for
-- its jurisdiction. NULL = automatic purge disabled (e.g. a legal hold) — the
-- escape hatch, not the default.

alter table workspaces
  add column if not exists retention_days int default 1825;

-- Supports the daily purge's resolved_at < cutoff scan. Partial: only resolved
-- tickets are ever purge candidates.
create index if not exists tickets_resolved_at_idx
  on tickets (resolved_at) where resolved_at is not null;
