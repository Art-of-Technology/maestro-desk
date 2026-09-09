# AI setup

Respovia uses the server's `ANTHROPIC_API_KEY` for drafts, summaries,
translation, language detection, workspace chat, triage, sentiment and KB
suggestions. Browser AI requests use the existing session and workspace
headers. The browser does not receive the provider key.

## Production setup

1. In Dokploy's **respovia-api** application, verify `ANTHROPIC_API_KEY` is
   present and that the Anthropic account has billing credit. Keep its existing
   value if it works. Do not put it in the frontend environment or a browser.
2. Release the API first, then **respovia-web**, from the same reviewed commit.
   No database migration or additional environment variable is required.
3. In **Platform → Brands**, set the intended brand's AI credit balance using
   the existing platform-admin control. Do not change another brand's balance.
   The field is in micro-USD: 1,000,000 means $1. This is an internal allowance,
   not a payment to Anthropic. Choose the allowance with the workspace owner.
4. In that workspace's **Settings → AI Assistant**, select a model and click
   **Check connection**. This checks the server key and model access without a
   paid generation. It does not prove the provider account has billing credit.
5. Confirm the displayed workspace credit, then try a short synthetic draft,
   summary, translation and chat. Check that `ai_usage_log` records each action
   and that the workspace credit decreases by the recorded cost.
6. Keep **Include player account details** off unless the workspace has opted
   in. Only workspace admins can change this existing setting.

The reviewed implementation supports the existing Sonnet 4.6, Haiku 4.5 and
Opus 4.7 options. The agent's model preference applies to interactive requests;
triage, sentiment and KB ranking retain their existing server model choices.

## Privacy and context

Chat reads records on the server, scoped to the authenticated workspace. The
context selectors include at most 100 records per source, capped at 50,000
characters in total. Results describe a sample, not workspace-wide totals.
Customer context includes names and identifiers; VIP tier, brand and
jurisdiction require `ai_player_enrichment`. AML fields, contact details and
live account balances are not added to chat context. Existing triage enrichment
retains its own opt-in handling. Free-form ticket text and messages entered by
agents can still contain personal information.

Chat history is stored in the current tab's session storage, separated by user
and workspace. Legacy unscoped browser history is not loaded or migrated because
its owner cannot be established. Legacy browser provider keys are removed when
the updated client loads.

## Request controls and accounting

- Only authenticated workspace members (or platform administrators) can call
  `/api/v1/ai/status`, `/check` and `/messages`.
- POSTs are limited to 60 per user/workspace per minute. Limiter failures block
  calls. Request bodies are capped at 256 KiB, conversation text at 60,000
  characters, messages at 40 and output at 2,048 tokens.
- The relay accepts only priced models. It reserves a conservative allowance
  before calling the provider, then refunds the unused portion and writes the
  usage record in one database transaction. Simultaneous relay calls cannot
  reserve the same credit. An allowance too small for the reservation returns
  HTTP 402 even if the eventual actual cost might have fit.
- Provider calls have a 45-second timeout and automatic retries disabled.
  Provider failures refund the reservation and return a generic error. An
  ambiguous network timeout may still have incurred provider usage.
- A process crash between reservation and settlement, or a settlement DB
  failure, can leave the reservation charged. Operators must reconcile unusual
  differences with provider usage before adjusting the internal allowance.
  The existing triage/sentiment/KB preflight accounting is unchanged; this relay
  does not turn the entire application's allowance into a strict billing cap.

The API uses the existing [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create).
The browser's content security policy no longer permits direct Anthropic calls.

## Validation and rollout status (2026-09-09)

- The local server key passed model access checks for Sonnet 4.6 and Opus 4.7.
- Five real generation requests passed under Node + tsx, using synthetic text
  and an isolated local Postgres 17 database. Haiku handled draft, summary,
  translation and detection; Sonnet handled chat. Total recorded cost was
  $0.002886 and the balance matched the usage ledger exactly. Test users and
  workspaces were removed afterwards.
- 613 backend tests passed, including database-backed workspace isolation;
  typechecking passed. Frontend build, import/header audits and route/detail
  smokes passed. `scripts/ai-browser-check.mjs` exercises all interactive AI
  actions, settings events, error handling and chat isolation with fixture APIs.
- Production key validity, provider billing and per-brand balances have **not**
  been verified. Production access is not configured in this session. No
  production deployment or credit change has been made.
