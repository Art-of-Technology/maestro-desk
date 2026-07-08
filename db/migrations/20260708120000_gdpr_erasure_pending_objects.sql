-- GDPR erasure: durable retry for attachment-object deletion.
--
-- When eraseCustomer() deletes a customer's ticket_attachments rows, it also
-- deletes the backing R2 objects AFTER the transaction commits (R2 is not
-- transactional). If that post-commit object delete fails, the DB rows are
-- already gone, so this column is the only durable record of which storage keys
-- still need deleting. retryPendingObjectDeletions() (run from the retention
-- cron) reads these, re-attempts the delete, and clears the column on success.
--
-- NULL / empty = nothing pending (the normal case).
alter table gdpr_erasures
  add column if not exists pending_object_keys text[];

-- Partial index so the retry sweep only scans rows that actually have pending
-- keys (expected to be near-empty in normal operation).
create index if not exists gdpr_erasures_pending_objects_idx
  on gdpr_erasures (completed_at)
  where pending_object_keys is not null and cardinality(pending_object_keys) > 0;
