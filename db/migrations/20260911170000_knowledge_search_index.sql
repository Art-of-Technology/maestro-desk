-- Compute search terms when articles change, not on every AI request.
alter table kb_articles add column search_document tsvector
  generated always as (to_tsvector('simple'::regconfig, title || ' ' || body)) stored;
create index kb_published_search on kb_articles using gin(search_document)
  where status = 'published';
