# Reply delivery confirmation

Public agent replies (including retries and Send without AI) save a unique send
attempt reference and an RFC Message-ID before calling Postmark. Postmark receives
the workspace, message and attempt IDs as metadata. These references let a delivery
receipt recover an unconfirmed send without sending the email again.

`POST /api/v1/webhooks/postmark/delivery` uses the existing Postmark webhook
credentials. It validates the payload and matches the original message, workspace,
current attempt and recipient. Untracked events are acknowledged without writes.
Deleted, erased and merged copies cannot be revived. Duplicate receipts do not
change the saved result; concurrent recipients are serialized on the message row.
Database failures return 500 so Postmark can retry. Payloads and addresses are not
written to application logs.

The send acknowledgement merges its data with existing receipts. A receipt that
arrives before a timeout prevents the send path from replacing confirmed success
with an unknown outcome. Receipts also restore the saved threading Message-ID.

## What agents see

- **Sent**: Postmark accepted the send, without recipient delivery confirmation.
- **Partially delivered**: at least one, but not every distinct To/CC recipient is confirmed.
- **Delivered**: all distinct To/CC recipients' mail servers accepted the email.
- **Delivery unconfirmed**: the send outcome is still unknown; retry remains blocked.

Email details show confirmed recipients and their individual delivery times. The
date alongside the message remains its send time (the saved attempt time if the
send acknowledgement was lost). Reopening/refreshing the ticket reads new receipts.
Delivery does not prove inbox placement or that the recipient read the email.

## Activation

1. Deploy the API and frontend through the normal Dokploy release process.
2. On the production Postmark server's **outbound** message stream, add a delivery
   webhook for `https://api.respovia.com/api/v1/webhooks/postmark/delivery`, using
   HTTP Basic Auth username `postmark` and the existing `POSTMARK_INBOUND_SECRET`
   as password. Enable the Delivery trigger. Keep inbound/bounce webhooks intact.
   Do not put credentials in the URL or logs.
3. Use an authorised test recipient. Check Sent followed by Delivered and the
   per-recipient time. Check Postmark webhook activity for a successful response.
   With an authorised CC recipient, verify partial and complete confirmation.

No new dependency, secret or database migration is required. Use the same server
and stream configured by the application's `POSTMARK_SERVER_TOKEN`.

## Historical messages and limits

Existing TK-133 sends lack these saved references. Do not match historical sends
using subject, recipient and approximate time alone, or resend them automatically.
Confirm their exact identity and delivery in Postmark before any manual repair.
This change does not backfill old records or send historical messages.

The separately approved TK-133 repair is `api/scripts/reconcile-tk133-email.ts`.
Run it with operator `DATABASE_URL` and `POSTMARK_SERVER_TOKEN`; the default is a
dry run. `--apply --confirm <snapshotHash>` commits the two approved 16 October
sends together only if the rows still match the dry-run fingerprint. It fetches
only their two known Postmark IDs, checks sender/recipients and delivery events,
matches exact saved email content (or the complete legacy body), rejects ambiguous
matches, and locks the live workspace/customer/ticket/messages before writing.
It refuses other tickets, timestamps, merged/deleted/erased rows and conflicting
send identifiers. It never sends mail. Repeated apply is a no-op after verification.

The repair changes only `external_message_id` and `email_metadata`. Previous values
are retained under `email_metadata.delivery_repair`, with the repair marker and
time. Recovery, if necessary, restores `previous_external_message_id` and
`previous_email_metadata` from that marker for the two reviewed rows; inspect
subsequent changes first. Output contains row/provider IDs and counts, never email
content or addresses. No database migration or API route is added. The script is
not copied into the production app image; run a reviewed bundle in an isolated
maintenance process on the existing internal database network, dry run first.

Operator steps (Dokploy owner/admin):

1. Build the reviewed source from the repository root:
   `bun build api/scripts/reconcile-tk133-email.ts --target node --format esm --outfile reconcile-tk133-email.mjs`.
2. Upload that bundle to `/tmp/reconcile-tk133-email.mjs` in the running production
   API container. Use its existing environment and internal database connection;
   do not expose a database port or copy credentials into commands/chat.
3. Run `node /tmp/reconcile-tk133-email.mjs`. Require `mode: dry-run` and exactly
   two rows with the approved provider IDs. Retain its `snapshotHash`.
4. Run `node /tmp/reconcile-tk133-email.mjs --apply --confirm <snapshotHash>`.
   Require `mode: apply` and two rows. Re-run the dry run; both must report
   `alreadyRepaired: true`. Refresh TK-133 and check both delivery times.
5. Remove the temporary bundle. No recurring maintenance schedule is needed.

The current integration account cannot create server-level schedules (Dokploy
returns 403: only owners/admins can manage them). Production execution therefore
requires an owner/admin; the tested bundle itself grants no additional access.

This tracks agent replies only. AI auto-replies, forwards, surveys and other
notifications keep their existing send behaviour. There is no background provider
polling or automatic resend. If a receipt never arrives, the state remains
unconfirmed; inspect Postmark's delivery history and webhook activity.

## Validation

Database-backed tests use a disposable PostgreSQL 17 database and mocked Postmark
responses. They cover lost responses, early/concurrent and duplicate receipts,
stale attempts, provider/recipient/workspace mismatches, authentication, malformed
payloads, storage failure responses, erasure and retry protection. Frontend tests
cover delivery labels, recipient counts and existing retry controls. Production
webhook activation and real-mail delivery require the release check above.

References: [Postmark delivery webhook](https://postmarkapp.com/developer/webhooks/delivery-webhook)
and [email API metadata](https://postmarkapp.com/developer/api/email-api).
