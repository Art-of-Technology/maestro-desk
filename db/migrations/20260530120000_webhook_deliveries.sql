-- Per-event delivery queue for outgoing webhooks. Replaces the
-- previous "POST synchronously inside the request handler, write
-- last_delivery_* to workspace_webhooks, move on" model with a
-- persistent queue that survives API restarts and supports
-- exponential-backoff retries on transient failure.
--
-- One row per (webhook × event). The payload is materialised at
-- enqueue time (jsonb) so retries always sign the exact same bytes
-- — important because the receiver's HMAC check is over the raw
-- body, and re-deriving the payload at retry time would diverge
-- if the ticket has since been edited.
--
-- Cleanup note: two orphan tables (public.webhook_deliveries with a
-- different shape, public.webhooks) survived from an earlier
-- prototype and were never wired into any migration or app code.
-- Drop them here so the canonical names are available.

drop table if exists public.webhook_deliveries;
drop table if exists public.webhooks;

create table webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  webhook_id      uuid not null references workspace_webhooks(id) on delete cascade,
  event           text not null,
  payload         jsonb not null,
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_status     int,
  last_error      text,
  last_attempt_at timestamptz,
  state           text not null default 'pending'
    check (state in ('pending', 'success', 'exhausted')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Worker scan: "pending rows whose backoff timer has elapsed."
create index webhook_deliveries_pending_idx
  on webhook_deliveries (next_attempt_at)
  where state = 'pending';

-- Per-webhook listing for the SPA.
create index webhook_deliveries_by_webhook_idx
  on webhook_deliveries (webhook_id, created_at desc);

create trigger set_updated_at before update on webhook_deliveries
  for each row execute function trigger_set_updated_at();
