-- DATA MIGRATION (irreversible by design): clear the materialised
-- can_manage_custom_fields=true from admin roles.
--
-- What it changes: every roles row with is_admin = true that carries
-- can_manage_custom_fields = true is set back to false.
--
-- Why: 20260619130000 backfilled admin roles with a materialised true, which
-- created a demotion-retention leak — a role later demoted from is_admin
-- silently kept managing custom fields. The capability model introduced with
-- can_delete (20260818120000) makes the admin grant IMPLICIT instead: every
-- read path (api/src/lib/authz.ts requireCustomFieldManager, routes/whoami.ts,
-- lib/maestro-workspace.ts, and the SPA role map) computes
-- `is_admin OR can_manage_custom_fields`, so raw column values mean exactly
-- "explicitly granted". This migration brings existing rows in line with that
-- rule.
--
-- Effective permissions change for NOBODY: admins keep managing custom fields
-- via is_admin at read time. What is lost — knowingly — is the historical raw
-- true on admin rows; it carried no independent information (every admin row
-- got it from the blanket 20260619130000 backfill, never from an individual
-- grant), which is why the reversal is acceptable.
--
-- Explicit non-admin grants (e.g. the seeded Senior Agent) are untouched.
update roles
  set can_manage_custom_fields = false
  where is_admin = true and can_manage_custom_fields = true;
