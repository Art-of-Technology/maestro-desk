# Customer reply / internal reference separation

Validated 2026-09-15 against main, independently of the game-directory PR.

## Behavior

- Composer suggestions use a forced structured response: customer text, source IDs, and agent notes are separate fields.
- Server resolves IDs against the supplied catalog and rejects malformed responses or obvious Draft / knowledge-base annotations. Raw provider text is never a fallback.
- The editor receives customer text only, preserving public game links. Sources and notes appear in a separate **Internal references — not sent** panel.
- Internal metadata uses a separate draft-storage key scoped to workspace, agent, ticket and tab. Successful sending clears it.
- Lookup failures, invalid responses, workspace switches and edits during generation do not replace an existing reply.

## Evidence

- API typecheck and frontend bundle passed.
- Full API suite with isolated PostgreSQL 17 and all 96 main migrations: 707 passed, 0 failed; 3,515 assertions.
- Composer controller tests: 4 passed / 19 assertions. Storage and renderer test: 1 passed / 10 assertions.
- All 24 route and 7 ticket-detail smokes passed; import audit and diff whitespace checks passed.
- Browser QA loaded local frontend modules with mocked AI and outbound mutations. The outgoing request contained only role, customer body and customer HTML, including the game URL; neither internal marker nor source ID appeared. The review panel and its scoped storage cleared after the simulated successful send. No real email was sent.
- Code review checked response validation, tenant-filtered published source retrieval, metadata storage separation, escaped rendering, safe link protocols, paid-generation accounting and stale-response handling. Corrected an undefined background token to the existing `--off` token.

## Limits

Provider behavior was mocked; no paid live generation was needed. Structured fields prevent metadata from being copied into the editor, while the wording checks catch common leaks rather than every possible phrasing. Agents still review factual accuracy before sending. Internal references accompany the local draft; they are not a permanent server-side audit record.
