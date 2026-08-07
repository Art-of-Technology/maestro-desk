-- Per-channel inbound ticket defaults + real channel management.
--
-- Channels gain a default priority so an email's To: address can set the
-- urgency of the ticket it creates (complaint@ -> urgent, support@ -> normal).
-- The inbound path (api/src/lib/inbound-email.ts) resolves the channel by
-- To: address BEFORE the ticket insert and applies default_priority_key +
-- the pre-existing default_category_key.
--
-- Channels also gain soft delete: inbox_messages.channel_id is NOT NULL with
-- ON DELETE CASCADE, so a hard delete would wipe the channel's inbox audit
-- trail. The new write API (routes/channels.ts) only ever sets deleted_at.

alter table channels add column default_priority_key text;
alter table channels add column deleted_at timestamptz;

-- Composite FK to the per-workspace priority lookup. The column list on
-- SET NULL (PG 15+) is required: a bare SET NULL on a composite FK nulls
-- EVERY referencing column including NOT NULL workspace_id, turning a
-- priority-row delete into an error instead of clearing the default.
alter table channels
  add constraint channels_default_priority_fk
  foreign key (workspace_id, default_priority_key)
  references ticket_priorities (workspace_id, key)
  on delete set null (default_priority_key);

-- Extend the atomic display-id allocator (20260619140000) to channels so the
-- write API can mint CH-<n> ids. Same pattern as the original migration:
-- widen the kind check, then seed each workspace above its current max
-- numeric suffix (CH-001 -> 1) so new ids never collide with seeded ones.
alter table workspace_display_id_seq
  drop constraint workspace_display_id_seq_kind_check;
alter table workspace_display_id_seq
  add constraint workspace_display_id_seq_kind_check
  check (kind in ('ticket', 'customer', 'channel'));

insert into workspace_display_id_seq (workspace_id, kind, last_value)
  select workspace_id, 'channel',
         max(coalesce(nullif(regexp_replace(display_id, '\D', '', 'g'), '')::bigint, 0))
  from channels
  group by workspace_id
on conflict (workspace_id, kind) do nothing;
