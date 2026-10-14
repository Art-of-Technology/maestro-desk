// Data-subject access / portability export for a customer (GDPR Art. 15 / 20).
//
// The inverse of erasure: gather every piece of the customer's personal data
// across the surfaces enumerated in `docs/gdpr-pii-inventory.md` into one
// structured, machine-readable bundle. Returns null if the customer doesn't
// exist in the workspace (caller → 404).
//
// Scoped by workspace_id throughout — no DB-level tenant guard, so every query
// carries the predicate.

import { getDb } from './db.js';
import { inboxFromThisCustomer } from './customer-contacts.js';
import { customerAuditHistory } from './customer-history.js';

export interface CustomerExport {
  exported_at: string;
  review_required: true;
  attachment_contents_included: false;
  custom_fields: Array<Record<string, unknown>>;
  // Provenance for the data subject: which brand/workspace held the data. The
  // internal workspace uuid is deliberately not exposed (cf. the stripped
  // customer.id).
  workspace: { name: string; slug: string };
  // erased_at is surfaced so the caller can distinguish a live record from one
  // whose PII has already been erased (mostly-null bundle).
  erased: boolean;
  customer: Record<string, unknown>;
  notes: Array<{ text: string; created_at: string }>;
  note_revisions: Array<Record<string, unknown>>;
  // Every address the subject holds (Phase 4 contacts model), primary flagged.
  contacts: Array<{ kind: string; value: string; is_primary: boolean; created_at: string }>;
  tickets: Array<Record<string, unknown> & { messages: Array<Record<string, unknown>>; attachments: Array<Record<string, unknown>> }>;
  inbox_messages: Array<Record<string, unknown>>;
  related_ai_copies: Array<Record<string, unknown>>;
  activity_history: Array<Record<string, unknown>>;
  audit_history: Array<Record<string, unknown>>;
  erasure_history: Array<Record<string, unknown>>;
  history_review_notice: string;
}

export async function exportCustomer(args: {
  workspaceId: string;
  customerId: string;
}): Promise<CustomerExport | null> {
  const { workspaceId, customerId } = args;
  return getDb().begin('isolation level repeatable read read only', async sql => {

  const [customer] = await sql<Record<string, unknown>[]>`
    select id, display_id, first_name, last_name, username, email, mobile, brand,
           vip_tier, jurisdiction, consent, since, backoffice_url, is_spam,
           to_jsonb(customers) ->> 'kyc_status' as kyc_status,
           to_jsonb(customers) ? 'kyc_status' as has_legacy_kyc,
           maestro_user_id, maestro_member_id,
           created_at, updated_at, erased_at
    from customers
    where id = ${customerId} and workspace_id = ${workspaceId}
  `;
  if (!customer) return null;

  const [ws] = await sql<{ name: string; slug: string }[]>`
    select name, slug from workspaces where id = ${workspaceId}
  `;

  const notes = await sql<{ text: string; created_at: string }[]>`
    select text, created_at from customer_notes
    where workspace_id = ${workspaceId} and (customer_id = ${customerId} or merged_from_customer_id = ${customerId})
    order by created_at asc
  `;

  const noteRevisions = await sql`select r.id, r.ticket_message_id, r.customer_note_id,
      r.editor_label, r.before_text, r.after_text, r.before_html, r.created_at
    from note_revisions r
    left join customer_notes n on n.id = r.customer_note_id and n.workspace_id = r.workspace_id
    left join ticket_messages m on m.id = r.ticket_message_id and m.workspace_id = r.workspace_id
    left join tickets t on t.id = m.ticket_id and t.workspace_id = r.workspace_id
    left join tickets source on source.id = m.merged_from_id and source.workspace_id = r.workspace_id
    where r.workspace_id = ${workspaceId} and
      (n.customer_id = ${customerId} or n.merged_from_customer_id = ${customerId}
        or t.customer_id = ${customerId} or source.customer_id = ${customerId})
    order by r.created_at, r.id`;

  // Contact rows — including any a merge re-homed onto a survivor (stamped
  // merged_from_customer_id = this customer): still this person's data, with
  // the primary flag they held before the merge.
  const contacts = await sql<{ kind: string; value: string; is_primary: boolean; created_at: string }[]>`
    select kind, value::text as value,
           case when merged_from_customer_id = ${customerId} then primary_before_merge else is_primary end as is_primary,
           created_at
    from customer_contacts
    where workspace_id = ${workspaceId}
      and (customer_id = ${customerId} or merged_from_customer_id = ${customerId})
      and (deleted_at is null or merged_from_customer_id = ${customerId})
    order by kind, created_at asc
  `;

  const tickets = await sql<Record<string, unknown>[]>`
    select id, display_id, subject, status_key, priority_key, category_key,
           ai_summary, ai_draft_reply, csat_score, csat_comment, snooze_reason, last_inbound_email, closure_reason, closure_note, closed_at, created_at, updated_at, resolved_at
    from tickets
    where workspace_id = ${workspaceId} and (customer_id = ${customerId} or pre_merge_customer_id = ${customerId})
    order by created_at asc
  `;
  const ticketIds = tickets.map((t) => t.id as string);
  const activityHistory = await sql`select id,entity_type,entity_id,kind,author_user_id,author_label,details,created_at
    from events where workspace_id=${workspaceId} and (
      (entity_type='customer' and entity_id=${customerId}) or
      (entity_type='ticket' and entity_id=any(${ticketIds}::uuid[]))) order by created_at,id`;
  const auditHistory = await customerAuditHistory(sql,workspaceId,customerId);
  const erasureHistory = await sql`select requested_at,completed_at,fields_erased,reason
    from gdpr_erasures where workspace_id=${workspaceId} and customer_id=${customerId} order by requested_at,id`;
  const customFields = await sql<Record<string, unknown>[]>`
    select v.entity_type, v.entity_id, f.key, f.label, f.field_type, v.value, v.updated_at
    from custom_field_values v join custom_fields f
      on f.id=v.field_id and f.workspace_id=v.workspace_id and f.entity_type=v.entity_type
    where v.workspace_id=${workspaceId} and (
      (v.entity_type='customer' and v.entity_id=${customerId}) or
      (v.entity_type='ticket' and ${ticketIds.length ? sql`v.entity_id in ${sql(ticketIds)}` : sql`false`})
    ) order by f.sort_order, f.key`;
  const fieldsFor = (type: string, id: string) => customFields
    .filter(v => v.entity_type===type && v.entity_id===id)
    .map(({entity_id: _id, entity_type: _type, ...value}) => value);
  const drafts = ticketIds.length ? await sql<Record<string, unknown>[]>`
    select ticket_id, compose_tab, body, recipients, review, attachment_ids, updated_at
    from message_drafts where workspace_id=${workspaceId} and ticket_id in ${sql(ticketIds)}
    order by updated_at, user_id, compose_tab` : [];

  // All messages for the customer's tickets in one query, grouped in JS.
  const messages = ticketIds.length
    ? await sql<Record<string, unknown>[]>`
        select case when ticket_id in ${sql(ticketIds)} then ticket_id
          when merged_from_id in ${sql(ticketIds)} then merged_from_id
          else (select x from unnest(forwarded_from_ticket_ids) x where x=any(${ticketIds}::uuid[]) limit 1) end as ticket_id,
          role, author_label, body, body_html, email_metadata, sent_email, forwarded_from_ticket_ids, created_at, deleted_at, merged_from_id
        from ticket_messages
        where workspace_id = ${workspaceId} and (ticket_id in ${sql(ticketIds)} or merged_from_id in ${sql(ticketIds)} or forwarded_from_ticket_ids && ${ticketIds}::uuid[])
        order by created_at asc
      `
    : [];
  const byTicket = new Map<string, Array<Record<string, unknown>>>();
  for (const m of messages) {
    const key = m.ticket_id as string;
    if (!byTicket.has(key)) byTicket.set(key, []);
    // Drop the join key from the emitted message.
    const { ticket_id: _drop, ...rest } = m;
    byTicket.get(key)!.push(rest);
  }
  // Attachment METADATA (Art. 15 "categories of data"), not the files: the
  // export is a JSON document, and the bytes stay behind the private bucket's
  // presigned URLs. Erasure deletes both, so the two stay in step.
  const attachments = ticketIds.length
    ? await sql<Record<string, unknown>[]>`
        select id, ticket_id, filename, size_bytes, mime_type, is_inline, created_at
        from ticket_attachments
        where workspace_id = ${workspaceId} and ticket_id in ${sql(ticketIds)}
        order by created_at asc
      `
    : [];
  const attByTicket = new Map<string, Array<Record<string, unknown>>>();
  for (const a of attachments) {
    const key = a.ticket_id as string;
    if (!attByTicket.has(key)) attByTicket.set(key, []);
    const { ticket_id: _dropAtt, id: _attId, ...rest } = a;
    attByTicket.get(key)!.push(rest);
  }

  const time = ticketIds.length ? await sql`select ticket_id,minutes,note,billable,created_at
    from time_entries where workspace_id=${workspaceId} and ticket_id in ${sql(ticketIds)} order by created_at,id` : [];
  const tags = ticketIds.length ? await sql`select ticket_id,tag from ticket_tags
    where workspace_id=${workspaceId} and ticket_id in ${sql(ticketIds)} order by tag` : [];
  const aiTags = ticketIds.length ? await sql`select ticket_id,tag,confidence,accepted from ticket_ai_tags
    where workspace_id=${workspaceId} and ticket_id in ${sql(ticketIds)} order by tag` : [];
  const reviews = ticketIds.length ? await sql`select case when m.ticket_id in ${sql(ticketIds)} then m.ticket_id else m.merged_from_id end as ticket_id,
    r.review,r.saved_at from reply_internal_reviews r join ticket_messages m on m.id=r.message_id and m.workspace_id=r.workspace_id
    where r.workspace_id=${workspaceId} and (m.ticket_id in ${sql(ticketIds)} or m.merged_from_id in ${sql(ticketIds)}) order by r.saved_at,r.message_id` : [];
  const suggestions = ticketIds.length ? await sql`select s.ticket_id,s.reply,s.draft_body,s.draft_is_html,s.draft_review,
    s.reply_context,s.reply_language,s.created_at,s.draft_updated_at,f.helpful,f.reason,f.resolution_notes
    from ai_reply_suggestions s left join ai_reply_feedback f on f.suggestion_id=s.id
    where s.workspace_id=${workspaceId} and (s.ticket_id in ${sql(ticketIds)} or exists
      (select 1 from ai_reply_suggestion_sources x where x.suggestion_id=s.id and x.ticket_id in ${sql(ticketIds)}))
    order by s.created_at,s.id` : [];
  const valuesFor = (rows: Array<Record<string,unknown>>, id: unknown) => rows.filter(r => r.ticket_id===id)
    .map(({ticket_id:_id,...rest}) => rest);
  const ticketsWithMessages = tickets.map((t) => {
    const { id: _id, ...rest } = t;
    return {
      ...rest,
      time_entries: valuesFor(time,t.id), tags: valuesFor(tags,t.id), ai_tags: valuesFor(aiTags,t.id),
      saved_reviews: valuesFor(reviews,t.id), ai_suggestions: valuesFor(suggestions,t.id),
      custom_fields: fieldsFor('ticket',t.id as string),
      drafts: drafts.filter(d => d.ticket_id===t.id).map(d => ({
        compose_tab:d.compose_tab, body:d.body, recipients:d.recipients, review:d.review, updated_at:d.updated_at,
        attachments:attachments.filter(a => a.ticket_id===t.id && (d.attachment_ids as string[]).includes(a.id as string))
          .map(({id:_id,ticket_id:_ticketId,...file})=>file),
      })),
      messages: byTicket.get(t.id as string) ?? [],
      attachments: attByTicket.get(t.id as string) ?? [],
    };
  });

  // Inbound mail tied to this customer: converted into one of their tickets, or
  // sent from ANY email address they held at the time (still in the inbox) —
  // the contacts model accepts inbound from secondaries, a merged-away source's
  // scalar is null while its addresses live on the survivor, and an address
  // released here and adopted elsewhere must not leak the new holder's mail
  // into this bundle (inboxFromThisCustomer).
  const inbox = await sql<Record<string, unknown>[]>`
    select from_name, from_email, subject, body, body_html, received_at, status
    from inbox_messages
    where workspace_id = ${workspaceId}
      and (
        (${ticketIds.length ? sql`converted_ticket_id in ${sql(ticketIds)}` : sql`false`})
        or ${inboxFromThisCustomer(sql, workspaceId, customerId, customer.email as string | null)}
      )
    order by received_at asc
  `;

  // Strip the DB uuid from the emitted customer record (display_id is the
  // stable, non-internal identifier).
  const { id: _custId, has_legacy_kyc: hasLegacyKyc, ...customerOut } = customer;
  if (!hasLegacyKyc) delete customerOut.kyc_status;

  return {
    exported_at: new Date().toISOString(),
    review_required: true,
    attachment_contents_included: false,
    custom_fields: fieldsFor('customer',customerId),
    workspace: { name: ws?.name ?? '', slug: ws?.slug ?? '' },
    erased: Boolean(customer.erased_at),
    activity_history: activityHistory,
    audit_history: auditHistory,
    erasure_history: erasureHistory,
    history_review_notice: 'Audit records are retained and may include historical personal text. Review them before disclosure. Records without a reliable customer link require a separate search; this export does not establish complete erasure.',
    customer: customerOut,
    notes,
    note_revisions: noteRevisions,
    contacts,
    tickets: ticketsWithMessages,
    inbox_messages: inbox,
    related_ai_copies: suggestions.filter(s => !ticketIds.includes(s.ticket_id as string)).map(({ticket_id:_id,...rest}) => rest),
  };
  }) as Promise<CustomerExport | null>;
}
