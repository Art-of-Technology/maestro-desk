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

export interface CustomerExport {
  exported_at: string;
  // Provenance for the data subject: which brand/workspace held the data. The
  // internal workspace uuid is deliberately not exposed (cf. the stripped
  // customer.id).
  workspace: { name: string; slug: string };
  // erased_at is surfaced so the caller can distinguish a live record from one
  // whose PII has already been erased (mostly-null bundle).
  erased: boolean;
  customer: Record<string, unknown>;
  notes: Array<{ text: string; created_at: string }>;
  tickets: Array<Record<string, unknown> & { messages: Array<Record<string, unknown>> }>;
  inbox_messages: Array<Record<string, unknown>>;
}

export async function exportCustomer(args: {
  workspaceId: string;
  customerId: string;
}): Promise<CustomerExport | null> {
  const { workspaceId, customerId } = args;
  const sql = getDb();

  const [customer] = await sql<Record<string, unknown>[]>`
    select id, display_id, first_name, last_name, username, email, mobile, brand,
           vip_tier, jurisdiction, consent, kyc_status, since, backoffice_url,
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
    where workspace_id = ${workspaceId} and customer_id = ${customerId}
    order by created_at asc
  `;

  const tickets = await sql<Record<string, unknown>[]>`
    select id, display_id, subject, status_key, priority_key, category_key,
           csat_score, csat_comment, snooze_reason, created_at, updated_at, resolved_at
    from tickets
    where workspace_id = ${workspaceId} and customer_id = ${customerId}
    order by created_at asc
  `;
  const ticketIds = tickets.map((t) => t.id as string);

  // All messages for the customer's tickets in one query, grouped in JS.
  const messages = ticketIds.length
    ? await sql<Record<string, unknown>[]>`
        select ticket_id, role, author_label, body, created_at
        from ticket_messages
        where workspace_id = ${workspaceId} and ticket_id in ${sql(ticketIds)}
          and deleted_at is null
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
  const ticketsWithMessages = tickets.map((t) => {
    const { id: _id, ...rest } = t;
    return { ...rest, messages: byTicket.get(t.id as string) ?? [] };
  });

  // Inbound mail tied to this customer: converted into one of their tickets, or
  // sent from their email address (still in the inbox).
  const email = customer.email as string | null;
  const inbox = await sql<Record<string, unknown>[]>`
    select from_name, from_email, subject, body, received_at, status
    from inbox_messages
    where workspace_id = ${workspaceId}
      and (
        (${ticketIds.length ? sql`converted_ticket_id in ${sql(ticketIds)}` : sql`false`})
        or (${email ? sql`from_email = ${email}` : sql`false`})
      )
    order by received_at asc
  `;

  // Strip the DB uuid from the emitted customer record (display_id is the
  // stable, non-internal identifier).
  const { id: _custId, ...customerOut } = customer;

  return {
    exported_at: new Date().toISOString(),
    workspace: { name: ws?.name ?? '', slug: ws?.slug ?? '' },
    erased: Boolean(customer.erased_at),
    customer: customerOut,
    notes,
    tickets: ticketsWithMessages,
    inbox_messages: inbox,
  };
}
