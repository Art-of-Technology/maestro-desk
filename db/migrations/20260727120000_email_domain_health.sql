-- Email-domain health tracking for the self-serve sender-domain feature.
--
-- verified_at keeps its existing meaning ("first fully verified at Postmark",
-- never un-stamped). Health after that lives in degraded_at: a previously
-- verified domain whose Postmark DKIM/Return-Path verification lapsed (DNS
-- records removed) or whose From was rejected at send time. Derived status:
--   verified_at is null                  -> 'pending'
--   degraded_at is not null              -> 'degraded' (sender falls back to platform)
--   otherwise                            -> 'verified'
--
-- dns_records snapshots the Postmark DNS recommendations (DKIM TXT,
-- Return-Path CNAME, SPF/DMARC suggestions) captured at create/check time so
-- the settings page renders the copy-paste table without any Postmark call.

alter table workspace_email_domains
  add column degraded_at     timestamptz,
  add column degraded_reason text,
  add column last_checked_at timestamptz,
  add column dns_records     jsonb;

comment on column workspace_email_domains.degraded_at is
  'Non-null = was verified but Postmark verification lapsed or sends were rejected; outbound falls back to the platform sender until cleared.';
comment on column workspace_email_domains.dns_records is
  'Snapshot of Postmark dnsRecommendations() — rendered by the settings UI without hitting Postmark.';
