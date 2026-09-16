ALTER TABLE kb_saved_filters ADD COLUMN is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX kb_saved_filters_personal_default
  ON kb_saved_filters(workspace_id, user_id) WHERE is_default;
