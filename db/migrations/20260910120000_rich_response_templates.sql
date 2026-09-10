-- Additive: older clients continue reading/writing the plain body.
ALTER TABLE canned_responses ADD COLUMN IF NOT EXISTS body_html text;
