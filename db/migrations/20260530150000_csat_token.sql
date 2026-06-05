-- Per-ticket CSAT token. Embedded as ?csat=<token> in the customer
-- survey link; the public CSAT routes accept the token as proof the
-- caller has clicked through a real survey email and not just guessed
-- a ticket id. Stored as text (not uuid) so future-proof if we
-- migrate to a different signing scheme.

alter table tickets
  add column csat_token text unique;

create index tickets_csat_token_idx on tickets (csat_token) where csat_token is not null;
