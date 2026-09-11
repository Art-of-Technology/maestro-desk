# Knowledge sources

Workspace administrators can add public HTTPS pages or upload PDF, DOCX, PPTX,
PNG, JPEG and WebP files from **Knowledge → Website & file sources**. Imports
create a reviewable version; they do not become available to AI until published.
Publishing updates one linked article. Older versions can be republished.

Website checks run hourly, dispatched by the five-minute `knowledge-refresh`
GitHub Actions schedule. Each invocation handles ten due pages. This is a target,
not a freshness guarantee: scheduler delays, backlog, blocked sites and network
errors can delay checks. The UI shows the last successful check and errors.
Changed content stays in review while the previously approved article remains
published. AI context identifies pending updates and failed refreshes.

The importer reads server-returned HTML, without JavaScript, login, cookies or
recursive crawling. Add each page separately. A geographically restricted or
JavaScript-only site may require pasted text or a document export. Specify the
language and jurisdiction and check the preview against the original page.

## File limits and review

- Maximum 20 MB, 30 PDF pages or slides, and 200,000 extracted characters.
- OCR supports English and Spanish. Scanned PDF pages with little embedded text
  use OCR; verify numbers, dates and names before publishing.
- PDF excerpts retain page labels; PowerPoint excerpts retain slide order and
  labels. Word has no dependable page numbers.
- Office embedded images, charts and speaker notes are not interpreted. Upload
  important images separately. Convert older `.doc` and `.ppt` formats first.
- Two document extractions can run concurrently per API process. Excess work is
  saved for retry. An extraction has a 90-second ceiling and native parser limits.
- Originals use the existing private attachment bucket. Admin downloads expire
  after five minutes. Removing a source deletes its article and versions and
  queues the original for the existing object-deletion worker.

## AI behavior

AI Intelligence's Knowledge source and ticket draft actions retrieve published
article excerpts from the authenticated workspace. Selection is keyword-based,
limited to six articles and three passages per article; it is not exhaustive.
The server instructs the assistant to cite articles/pages/slides, treat source
text as untrusted, flag conflicting or missing rules, and avoid inventing player
statuses or policy. Drafts remain for agent review; model compliance is not a
replacement for policy ownership. Existing external KB sidebar integration is
unchanged. The normal Draft action uses Respovia's published workspace articles;
the optional external-KB reply action continues to use the configured external KB.

Published articles have a stored, indexed search document, refreshed automatically
when their title or body changes. Searches filter matches before ranking. Source
article display IDs use UUID-derived suffixes deliberately: the legacy manual
article helper uses only 9,000 random values and is not a sequential allocator.

## Operations

The API image installs Python, Poppler and Tesseract. Existing private R2 settings
are required for files; URL imports do not need R2. Migration
`20260911160000_knowledge_sources.sql` runs at container boot. The scheduler uses
the existing `CRON_SECRET` and `GET /api/v1/cron/knowledge-refresh`; CLI operators
can run `node --import tsx src/cron-run.ts knowledge-refresh`. Failures alert
through the existing cron alert channel. Monitor refresh age before increasing
source volume; the initial dispatch capacity is 120 pages per hour globally.

After deployment, verify an import, explicit publication, refresh with unchanged
content, changed-version review, and private original download. Preserve any
browser-only articles from the former empty-library persistence bug before
reloading; recreate them through the corrected New Article flow, checking for
duplicates first.
