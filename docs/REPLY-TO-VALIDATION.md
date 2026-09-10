# Public ticket Reply-To

Customer replies previously targeted the deployment's internal Postmark inbound
address even when the brand had a public support inbox. Agent replies, automatic
replies and CSAT surveys now share `resolveTicketReplyTo`:

1. Use the ticket's active, non-deleted email channel when its address is valid.
2. Otherwise use the workspace's existing verified, non-degraded branded sender
   only when it also matches an active, non-deleted email channel in that workspace.
3. Without a configured public inbox, retain `POSTMARK_INBOUND_REPLY_ADDRESS`.

Both the ticket lookup and channel join enforce workspace ownership. A missing
or deleted ticket returns no address. Threading headers, recipient selection,
bounce handling and From rejection recovery retain their existing behavior.
The deployment-wide inbound address is not changed to a particular brand.

Public inboxes must forward inbound mail to Postmark. Space Casino's existing
Postmark history confirms mail addressed to support@spacecasino.com reached
the configured inbound server. No forwarding or DNS configuration is changed.

## Validation

- DB-backed delivery tests capture actual Postmark request bodies for all three
  email paths, including a complaints inbox and agent/AI In-Reply-To headers.
- Resolver tests cover absent, inactive, deleted, non-email, empty and malformed
  channels; branded fallback; missing/deleted tickets; and foreign-workspace
  tickets/channels. Sending-domain verification alone does not enable the branded
  fallback; an absent, inactive or deleted support channel retains transport routing.
- Existing tests continue to cover recipient contacts, suppression, attachments,
  survey concurrency and branded sender rejection recovery.
- API typecheck, frontend build, import/bridge/header guards, 24 route smokes and
  seven ticket-detail smokes pass.

Review, full-suite and production verification evidence are recorded on the PR.
