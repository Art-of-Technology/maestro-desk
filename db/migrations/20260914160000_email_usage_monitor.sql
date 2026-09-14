-- Account-wide operational data. Exposed only through platform-admin routes.
CREATE TABLE email_usage_monitor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  snapshot jsonb,
  checked_at timestamptz,
  attempted_at timestamptz,
  last_error text,
  notified_cycle text,
  notified_threshold integer NOT NULL DEFAULT 0
);
INSERT INTO email_usage_monitor (singleton) VALUES (true);
