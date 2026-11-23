-- Review evidence stays in customer_notes, sharing note history, export and erasure.
alter table customer_notes add column name_review_key text;
create index customer_notes_name_review on customer_notes (workspace_id, customer_id, name_review_key)
  where name_review_key is not null and deleted_at is null;
