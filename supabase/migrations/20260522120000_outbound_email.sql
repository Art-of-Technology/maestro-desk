-- Outbound email support — store the RFC Message-ID for each ticket_message so
-- replies can thread properly in the customer's mail client.
--
-- For customer messages: this is the Message-ID header from the inbound email
-- (extracted from the Postmark webhook's Headers array). Used as In-Reply-To
-- when we send our reply back.
--
-- For our outbound messages: this is the Message-ID assigned by Postmark on
-- send. Stored so a future reply from the customer can be linked back via
-- In-Reply-To matching (deferred — not used yet, but cheap to capture now).
--
-- Nullable because not every message has one (system messages, agent notes,
-- AI messages predating this migration). No index for now — lookup is always
-- by ticket_id + role, which is already indexed.

alter table ticket_messages
  add column external_message_id text;
