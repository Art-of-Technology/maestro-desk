---
name: tagline-whatsnew
description: Use when preparing a release, creating or pushing a version tag, or writing user-facing release announcements in a repository connected to Tagline. Also use when a version shows no content in Tagline after tagging, or the team asks why the What's-New popup didn't appear.
---

# Tagline What's-New authoring

## Overview

Tagline turns a markdown file in this repository into an end-user popup.
The announcement travels with the code: Tagline reads
`.whatsnew/<version>.md` **at the commit the tag points to** and creates a
draft announcement for human review. No file at the tag → the version is
tracked with no announcement.

## The ordering rule (load-bearing)

The file must exist IN the tagged commit.

```
✅ commit .whatsnew/2.4.0.md  →  git tag v2.4.0  →  git push --tags
❌ git tag / push             →  add the file afterwards
```

A tag is a frozen snapshot — committing the file later can never attach
content to an already-pushed tag. If the tag is already out:

- **Don't** delete/re-push the tag on a shared repo.
- Either cut the next release with the file in place, or paste the content
  manually in the Tagline dashboard (Versions → the version → What's-New
  editor). Both are fine; retagging is not.

## Quick reference

| Thing | Value |
|---|---|
| File path | `.whatsnew/<version>.md` (no `v` prefix in filename), fallback: `.whatsnew/v<version>.md` |
| Tag format | semver, `v` optional — `v?MAJOR.MINOR.PATCH(-suffix)`; environments may claim a tag prefix (e.g. `rc-v1.2.3` → livetest only) |
| Prefixed tags | the FILE NAME never includes the prefix: tag `rc-v1.2.340` still reads `.whatsnew/1.2.340.md`. The rc tag and the later bare promotion tag are ONE version sharing that file |
| Prerelease suffixes | `rc-v1.2.343-xyz`, `-beta`, … are ITERATIONS of version `1.2.343` — they refresh `.whatsnew/1.2.343.md`; never create suffixed files for UAT churn. Exception: to ship a prerelease as its OWN user-faced version (public beta), commit `.whatsnew/1.2.343-beta.md` at that tag — the file's existence makes it distinct |
| Trigger | pushing the tag, or publishing a GitHub Release |
| Latency | draft appears in Tagline within seconds of the tag push |
| Allowed HTML after sanitization | `p, br, strong, em, a (http/https), ul, ol, li, h3, h4, code, pre, img (https only)` — everything else is stripped |
| Missed webhook | Tagline → app → Settings → **Sync now** (idempotent, last 50 tags) |
| Non-GitHub pipeline | `POST https://<tagline-host>/api/v1/manage/versions` with `Authorization: Bearer <secret key>` and `{ "label": "2.4.0", "whatsNew": { "contentMd": "..." } }` |

## Tracing without a popup

A `.whatsnew/` file signals *intent to announce* (it creates reviewable
drafts). For changes users should never see: put the notes in the GitHub
Release body (or the Tagline dashboard) instead — they attach to the
version as internal notes, visible in the dashboard, never publishable
as a popup. Every tag is version-tracked either way, file or no file.

## Writing the content

Write the file in the app's **primary language** (Tagline → app →
Settings → Languages — e.g. Turkish for a Turkish-audience app). Never
commit other languages to the repo: translations are portal-managed
(language tabs in the What's-New editor), and users automatically get
their language when a translation exists, the primary content otherwise.

Write for end users, not developers — benefits in plain words, short.
Never paste commit logs. Use `###`/`####` headings (`#`/`##` are stripped
by the sanitizer). Example `.whatsnew/2.4.0.md`:

```markdown
### Dashboard filters

Narrow any list to exactly the rows you need — filters now apply across
dashboards and analytics.

### CSV export

Take your data with you: one click exports the current view, filters
included.
```

## After the push — say this to the user, verbatim if needed

1. The draft appears in Tagline within seconds — **nothing auto-publishes**.
2. A person must review, target, and click **Publish** in the Tagline
   dashboard (app → Versions → the version → publication panel).
3. Only after publishing do end users see the popup, on their next page
   load in the matching environment.

## Verify

- Tagline → app → Versions: the new version row shows a content indicator.
- Not there? Confirm the tag really contains the file:
  `git ls-tree v2.4.0 --name-only -- .whatsnew/` — then use **Sync now**.

## Red flags — stop and fix

- Announcement written after the tag was pushed → too late for that tag;
  see the ordering rule.
- `#` or `##` headings, scripts, iframes, styles in the markdown → stripped
  silently; use `###`/`####` and the allowlist above.
- Telling the user "it's live" at tag time → false; publishing is a manual
  human step in the Tagline dashboard.
