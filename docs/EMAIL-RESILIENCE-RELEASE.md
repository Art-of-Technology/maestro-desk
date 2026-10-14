# Email resilience and AI checks

An unavailable AI provider or depleted AI credit can block the normal send path:
the browser detects/translates the body, then the API translates email branding
and the first outbound subject. Turning body translation off still detects its
language. A model lookup alone does not prove that paid generation works.

## Agent behaviour

- Existing replies: choose **Send without AI…** in the Send menu.
- New tickets: choose **Send without AI…** below the message.
- Confirm that the customer can understand the written message and the saved
  subject, header, signature and footer. The choice applies to this send only.
- Normal Send keeps its translation behaviour. There is no automatic fallback.
- Manual sends use the existing send path, omitting `reply_language`. Recipient
  validation, HTML sanitisation, attachments, draft versions, workspace access
  and delivery status still apply. Cancelling the confirmation sends nothing.
- An email-provider failure is separate from an AI failure. Read the delivery
  result: a reply saved on the ticket does not necessarily mean it was emailed.
  An ambiguous network response must not trigger an automatic resend.

## AI settings

**Check key and model (free)** still performs a model lookup. Its result explicitly
does not verify generation or billing credit.

**Test AI generation…** requires a confirmation explaining the small credit cost.
`POST /api/v1/ai/check-generation` accepts only a supported model. The server sends
fixed test text with a 16-token output limit, never customer/workspace content.
It uses the existing authenticated generation, workspace availability, atomic
credit reservation/refund/settlement and privacy checks. Usage is recorded as
`connection_check`. Tests are limited to three per minute per agent/workspace,
in addition to the existing AI request limit. Provider failures return safe
generic messages, distinct from insufficient workspace credit; they do not
claim that a specific provider billing problem has been established.

## Validation and release

Regression coverage includes manual-send confirmation/cancellation, retained
drafts, rich content and attachment IDs, recipient/upload checks, duplicate
clicks, changed drafts/workspaces, zero workspace credit, unavailable providers,
fixed test prompts, foreign-workspace denial, billing and bounded checks.
Browser fixtures exercise mobile/desktop controls and never send real mail or
make paid provider calls.

No database migrations, credentials or configuration changes are required.
Release the API before the web change so the generation-test endpoint exists.
An old API returns an error for that test; the UI must not report success.
After an approved release, use an authorised test recipient to verify a manual
send and its received branding, then explicitly run the generation test.
Do not revoke credentials based on the free check.

This change does not implement a durable email outbox or provider-delivery
idempotency. It retains the existing duplicate-click/draft protections and does
not automatically retry an uncertain email outcome. Broader mail recovery,
restore rehearsals, credential rotation and database restriction remain separate
audit work.
