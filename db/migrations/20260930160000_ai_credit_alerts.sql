-- Keep pending reservations separate so only actual spend starts a low-credit period.
alter table workspaces add column ai_reserved_micro bigint not null default 0;
alter table workspaces add column ai_low_credit_since timestamptz;

create function track_ai_low_credit() returns trigger language plpgsql as $$
begin
  if new.ai_credits_micro + new.ai_reserved_micro < 2000000 then
    new.ai_low_credit_since := coalesce(new.ai_low_credit_since, clock_timestamp());
  else
    new.ai_low_credit_since := null;
  end if;
  return new;
end;
$$;
create trigger workspace_ai_low_credit before insert or update of ai_credits_micro, ai_reserved_micro
  on workspaces for each row execute function track_ai_low_credit();
update workspaces set ai_low_credit_since = clock_timestamp() where ai_credits_micro < 2000000;

create table ai_credit_alert_receipts (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  low_since timestamptz not null,
  dismissed boolean not null default false,
  primary key (workspace_id, user_id)
);
