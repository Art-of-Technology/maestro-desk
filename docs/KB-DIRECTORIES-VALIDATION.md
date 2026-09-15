# Knowledge cards and game directories

## Behavior

- Cards and article details show the full server update timestamp in the browser's local timezone. Date-only demo records explicitly say their time is unavailable.
- A matching locale prefix is hidden from displayed card/detail titles when the category already identifies it. Stored titles and confirmation-dialog titles retain the locale for identification.
- Standalone Space Casino game URLs in `Games · locale` categories are grouped into expandable cards by locale and provider. Mismatched market paths, unrelated domains and multi-line bodies remain individual articles.
- Directories expose each original game link, review button, update time and status. Counts show mixed publishing states; directory selection includes only matching API-backed drafts. Existing filters and per-article publication remain authoritative.
- No articles are merged, deleted or automatically published. The inspected library's 1,589 game entries render as 91 directory cards; 650 other articles remain individual cards.

## Timestamp migration

Migration `20260915120000_kb_content_updated_at.sql` replaces only the knowledge-article update trigger. Content/category/title or status changes advance the timestamp; views, votes and no-op updates preserve it. Historical values are preserved because earlier activity cannot be distinguished from earlier edits. No schema columns or article values are rewritten. The migration can be reapplied; rollback would restore the previous generic trigger function on `kb_articles`.

## Retrieval and token use

Portal article suggestions previously included every published article in the model prompt. They now use a published-only, workspace-scoped full-text query ranked by title relevance, capped at 12 candidates and 600 body characters each. Empty/unmatched searches skip the model call. Game links remain individually searchable; provider directories are never sent wholesale.

The existing assistant lookup already limits its selection to six articles; its excerpts now include category metadata so the imported market remains visible alongside source metadata. The portal prompt explicitly tells the model not to treat market-specific game links as valid for another market.

This reduces candidate input size rather than guaranteeing a fixed currency/token saving. The database fixture with 150 entries selected 12 relevant records, kept the requested game URL intact, excluded draft/foreign-workspace records and used less than one fifth of the full fixture's serialized size. Ranking remains lexical, so synonyms without matching indexed terms can return no suggestions.

## Verification

- Full API suite against isolated PostgreSQL 17: 703 tests, zero failures, 3,492 assertions. Timestamp and retrieval cases use the real database and sessions.
- Frontend presentation tests cover locale removal, grouping without data mutations, malformed links, mixed statuses, timestamps and provider-name search. Persistence tests cover the full saved timestamp.
- Build, typecheck, import/collision guards and all 24 route render smokes pass.
- Separate browser QA tab served local frontend assets with every API mutation intercepted. Tested game search, provider search, per-game selection, group select/clear, open-directory retention and simulated publishing with mixed statuses. No production articles were published by these tests.
- Screenshots reviewed at 1280×900 and 768×1024. No tablet horizontal overflow; native summary controls, labelled checkboxes, focus outlines, readable dates and 44px actions use the existing design system. Existing phone sidebar/shared-modal limitations remain outside this change. UI review: 4/5.
- Code review caught and fixed the edit path's timestamp assignment, retained full locale titles in confirmation dialogs, and added search matching for displayed provider names.

Screenshots: `C:/Users/Jodi/Documents/kb-directories-desktop.png` and `kb-directories-tablet.png`.
