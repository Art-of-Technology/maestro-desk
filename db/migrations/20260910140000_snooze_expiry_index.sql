-- Keep the minute sweep proportional to snoozed work, not all ticket history.
create index if not exists tickets_pending_snooze_expiry_idx
  on tickets (snoozed_until, id)
  where snoozed_until is not null and deleted_at is null and merged_into_id is null
    and status_key in ('open', 'pending', 'escalated', 'gdpr');
