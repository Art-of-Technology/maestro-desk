-- Viewing and voting are activity, not content edits. Preserve existing dates:
-- older activity cannot be distinguished from historical edits retrospectively.
create or replace function public.kb_content_updated_at()
returns trigger language plpgsql as $$
begin
  if row(new.title, new.category, new.body, new.status)
     is distinct from row(old.title, old.category, old.body, old.status) then
    new.updated_at = now();
  else
    new.updated_at = old.updated_at;
  end if;
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.kb_articles;
create trigger set_updated_at before update on public.kb_articles
  for each row execute function public.kb_content_updated_at();
