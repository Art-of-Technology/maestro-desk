# Security Audit: Knowledge sources

**Stack:** Node 22, Hono, PostgreSQL, vanilla JavaScript, Python/native parsers
**Scope:** knowledge source feature diff and its dependency updates
**Date:** 2026-09-11
**Risk summary:** 0 critical, 0 high, 0 medium unresolved findings identified in this review.

## Findings

| ID | Sev | Category | Location | Issue | Fix |
|---|---|---|---|---|---|
| 1 | High (resolved) | Dependencies | api/bun.lock | Installed Undici had cache-interceptor advisories; Hono also had advisories | Updated compatible versions; audit now clean. This importer does not enable the affected cache interceptor. |
| 2 | Medium (resolved) | Upload validation | api/scripts/knowledge_extract.py | Image extension alone did not confirm file type | Added image signatures; PDF signature and Office ZIP/XML validation already enforced. |
| 3 | Medium (resolved) | Resource use | api/src/lib/knowledge-import.ts | Concurrent document parsing could exhaust the API host | Two concurrent document extractions, subprocess deadlines, memory/CPU/file limits and bounded output. |
| 4 | Low (resolved) | Tenant UI state | web/js/kb/index.js, sources.js | Late responses could update another brand or reopen a closed import | Captured workspace/session and checked before applying results; first-article double-submit guard. |

## Detail

All source routes require authenticated workspace administration and filter
workspace IDs in reads and writes. Cross-workspace IDs and ordinary members are
covered by database-backed tests. Publication checks version ownership inside a
transaction; unapproved imports are excluded from AI context. SQL parameters use
tagged queries. Input schemas whitelist fields. Source text and URLs are escaped
in the UI; originals are private, downloaded as attachments and never executed.

URL imports allow public HTTPS only, reject credentials/custom ports, validate
every redirect and apply the existing connect-time safe DNS lookup through
Undici on Node. Page bytes, redirects and elapsed time are bounded. Parser
subprocesses receive fixed argument arrays without a shell or application
secrets. Office archives are not extracted to user-controlled paths; DTD/entity
XML, encryption and excessive expanded sizes are rejected. No macros are run.

Source deletion, including workspace cascade deletion, uses the existing object
outbox. Active imports cannot be deleted through the source route. Import errors
are generic and do not expose parser paths or signed URLs. Download responses
are not cached. Rate limiting and a 100-source workspace cap bound ordinary use.

## Scanner output

- Dependencies: `bun audit` reports no known vulnerabilities after updating Hono
  and Undici. No additional npm packages introduced.
- SAST: Semgrep was not installed; manual diff review performed.
- Secrets: Gitleaks was not installed; changed code reviewed manually. Test
  credentials are synthetic and production credentials are not included.

## Remediation plan

No unresolved finding from this scoped review blocks the feature. Keep the base
image/native parsers patched. At larger volumes, move extraction to isolated
workers and increase scheduled refresh capacity; the current worker and source
limits are documented in KNOWLEDGE-SOURCES.md. This is a scoped review, not a
penetration-test certification or a review of the entire application's auth.
