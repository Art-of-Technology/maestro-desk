-- Restored website imports must not silently resume legacy schedules.
-- Administrators can explicitly enable hourly checks after reviewing each source.
UPDATE knowledge_sources SET auto_refresh = false, next_check_at = NULL WHERE kind = 'url';
ALTER TABLE knowledge_sources ALTER COLUMN auto_refresh SET DEFAULT false;
