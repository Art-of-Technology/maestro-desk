// ─── Customer contacts — multiple emails / mobiles per customer ──────────────
// The ONLY module that writes customer_contacts (Phase 4, PR 5). Everything
// else — the /customers routes, merge/unmerge, inbound mail, the portal, the
// Maestro player lookup, the bounce webhook — goes through the helpers here so
// the three invariants live in exactly one place:
//
//   1. MIRROR: customers.email / customers.mobile always equal the value of the
//      customer's primary row of that kind (or null when it has none). Written
//      in application code by syncPrimaryMirror(), never by a trigger (a
//      trigger would take a customers row lock on every contact write while the
//      merge transaction locks customers first and contacts second — ABBA).
//      Lock order everywhere: the customers row (`for update`) FIRST, then
//      contact rows.
//   2. ONE PRIMARY: a customer with ≥1 live row of a kind has exactly one
//      primary of that kind (customer_contacts_one_primary). The index is a
//      plain partial unique index checked per row, so flipping the primary is
//      two statements (clear, then set) inside one transaction.
//   3. SELF-HEALING: customers WILL exist with a scalar and no contact row —
//      every DB test fixture inserts `customers` directly, and a rollback to
//      the previous image after the boot-time migration creates them through
//      the old insert paths. ensurePrimaryContacts() is idempotent and runs at
//      the top of every contact-touching path, so the model never depends on
//      the backfill having been complete. Without it the first merge touching
//      such a row would null both mirrors, and inbound mail from it would 500
//      the Postmark webhook on every retry.
//
// Merge bookkeeping mirrors customer_notes.merged_from_customer_id: rows MOVE
// to the survivor stamped with the source id and the primary flag they held.
// A merged-away profile therefore has no live rows and null mirrors in the DB;
// buildCustomerContacts() derives its display addresses from the stamped rows
// so the SPA's Merged view keeps showing them.

import type postgres from 'postgres';

type Db = postgres.Sql<{}> | postgres.TransactionSql<{}>;

export type ContactKind = 'email' | 'mobile';
export const CONTACT_KINDS: readonly ContactKind[] = ['email', 'mobile'] as const;

export interface ContactRow {
  id: string;
  customer_id: string;
  kind: ContactKind;
  value: string;
  is_primary: boolean;
  bounce_state: string;
  bounce_count: number;
  bounce_last_type: string | null;
  bounce_last_at: string | null;
  merged_from_customer_id: string | null;
  primary_before_merge: boolean;
  deleted_at: string | null;
  created_at: string;
}

// Wire shape — GET /customers, the contact endpoints, merge/unmerge responses.
// `id` is null only for the synthesised legacy row (scalar present, no contact
// row yet — healed on first write). `on_survivor` marks a merged-away profile's
// address that now physically lives on its survivor.
export interface ContactOut {
  id: string | null;
  value: string;
  is_primary: boolean;
  bounce_state: string;
  bounce_count: number;
  bounce_last_at: string | null;
  merged_from_customer_id: string | null;
  on_survivor: boolean;
}

export interface CustomerContacts {
  email: string | null;
  mobile: string | null;
  emails: ContactOut[];
  mobiles: ContactOut[];
}

// Typed failure the routes map straight onto a JSON error (status + code).
export class ContactError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ContactError';
  }
}

// Trim; emails compare case-insensitively (citext) but are STORED lower-case so
// the wire shape is stable. Blank → null.
export function normalizeContactValue(kind: ContactKind, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  return kind === 'email' ? v.toLowerCase() : v;
}

interface CustomerScalars {
  id: string;
  merged_into_customer_id: string | null;
  email: string | null;
  mobile: string | null;
  email_bounce_state?: string | null;
  email_bounce_count?: number | null;
  email_last_bounce_at?: string | null;
}

const CONTACT_COLS = `id, customer_id, kind, value::text as value, is_primary, bounce_state, bounce_count,
  bounce_last_type, bounce_last_at, merged_from_customer_id, primary_before_merge, deleted_at, created_at`;

// ─── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Which live customer holds this address? Contact row first; then the legacy
 * scalar (a row created before the contacts table, or by a rolled-back image).
 * Returns the holder's id + merge pointer — callers that want the survivor
 * apply the existing single `merged_into_customer_id || id` hop themselves.
 * `heal: true` (write paths) backfills the legacy row's contacts on the spot.
 */
export async function resolveCustomerByContact(
  sql: Db,
  workspaceId: string,
  kind: ContactKind,
  value: unknown,
  opts: { heal?: boolean } = {},
): Promise<{ id: string; merged_into_customer_id: string | null } | null> {
  const v = normalizeContactValue(kind, value);
  if (!v) return null;

  const [hit] = await sql<{ id: string; merged_into_customer_id: string | null }[]>`
    select c.id, c.merged_into_customer_id
    from customer_contacts cc
    join customers c on c.id = cc.customer_id
    where cc.workspace_id = ${workspaceId} and cc.kind = ${kind} and cc.value = ${v}
      and cc.deleted_at is null and c.deleted_at is null
    limit 1
  `;
  if (hit) return hit;

  const [legacy] = kind === 'email'
    ? await sql<CustomerScalars[]>`
        select id, merged_into_customer_id, email, mobile from customers
        where workspace_id = ${workspaceId} and email = ${v} and deleted_at is null
        limit 1
      `
    : await sql<CustomerScalars[]>`
        select id, merged_into_customer_id, email, mobile from customers
        where workspace_id = ${workspaceId} and trim(mobile) = ${v} and deleted_at is null
        limit 1
      `;
  if (!legacy) return null;
  if (opts.heal) {
    await ensurePrimaryContacts(sql, { workspaceId, customerId: legacy.id, email: legacy.email, mobile: legacy.mobile });
  }
  return { id: legacy.id, merged_into_customer_id: legacy.merged_into_customer_id };
}

// ─── Self-heal ───────────────────────────────────────────────────────────────

/**
 * Give a customer its primary contact rows from its scalars IF it has no live
 * row of that kind. Idempotent; safe inside or outside a transaction. Skips
 * soft-deleted, erased and MERGED-AWAY profiles (their rows must not occupy
 * the unique indexes; a merged-away profile's addresses live on its survivor —
 * without this guard a heal racing a merge could land an unstamped row on the
 * just-merged source and break its unmerge). Bounce state is carried across
 * from the scalars, as the backfill does.
 *
 * `strict` (the three customer CREATE paths): an email already live on another
 * profile raises 23505 so the caller's transaction rolls back and its race
 * recovery resolves the winner. Default (heals of existing rows): the conflict
 * is swallowed — that profile owns the address. `allowMerged` is for unmerge
 * only: the source is still stamped merged-away while its rows come home.
 */
export async function ensurePrimaryContacts(
  sql: Db,
  args: { workspaceId: string; customerId: string; email?: string | null; mobile?: string | null },
  opts: { strict?: boolean; allowMerged?: boolean } = {},
): Promise<void> {
  const { workspaceId, customerId } = args;
  const email = normalizeContactValue('email', args.email);
  const mobile = normalizeContactValue('mobile', args.mobile);
  if (email) {
    const insert = sql`
      insert into customer_contacts
        (workspace_id, customer_id, kind, value, is_primary,
         bounce_state, bounce_last_type, bounce_last_at, bounce_count)
      select c.workspace_id, c.id, 'email', ${email}, true,
             c.email_bounce_state, c.email_last_bounce_type, c.email_last_bounce_at, c.email_bounce_count
      from customers c
      where c.id = ${customerId} and c.workspace_id = ${workspaceId}
        and c.deleted_at is null and c.erased_at is null
        and (c.merged_into_customer_id is null or ${Boolean(opts.allowMerged)})
        and not exists (
          select 1 from customer_contacts x
          where x.customer_id = c.id and x.kind = 'email' and x.deleted_at is null
        )
    `;
    if (opts.strict) {
      await insert;
    } else {
      await sql`${insert} on conflict (workspace_id, value) where kind = 'email' and deleted_at is null do nothing`;
    }
  }
  if (mobile) {
    await sql`
      insert into customer_contacts (workspace_id, customer_id, kind, value, is_primary)
      select c.workspace_id, c.id, 'mobile', ${mobile}, true
      from customers c
      where c.id = ${customerId} and c.workspace_id = ${workspaceId}
        and c.deleted_at is null and c.erased_at is null
        and (c.merged_into_customer_id is null or ${Boolean(opts.allowMerged)})
        and not exists (
          select 1 from customer_contacts x
          where x.customer_id = c.id and x.kind = 'mobile' and x.deleted_at is null
        )
      on conflict (customer_id, kind, value) where deleted_at is null do nothing
    `;
  }
}

// ─── Mirror + primary maintenance (transaction-internal) ─────────────────────

/** customers.email / mobile := the primary row's value (null when none), and
 *  customers.email_bounce_* := the primary EMAIL row's bounce state — the
 *  customer-level summary describes the primary address, so when the primary
 *  changes (set-primary, merge promotion) the suppression flag agent-reply,
 *  CSAT and the suppression list read must follow it. Never writes PII back
 *  onto an erased profile. Callers MUST have healed first. */
export async function syncPrimaryMirror(sql: Db, workspaceId: string, customerId: string): Promise<void> {
  await sql`
    update customers c set
      email = p.value,
      mobile = (select x.value::text from customer_contacts x
                where x.customer_id = c.id and x.kind = 'mobile' and x.is_primary and x.deleted_at is null
                limit 1),
      email_bounce_state     = coalesce(p.bounce_state, 'none'),
      email_last_bounce_type = p.bounce_last_type,
      email_last_bounce_at   = p.bounce_last_at,
      email_bounce_count     = coalesce(p.bounce_count, 0)
    from (
      select c2.id as customer_id, x.value, x.bounce_state, x.bounce_last_type, x.bounce_last_at, x.bounce_count
      from customers c2
      left join customer_contacts x
        on x.customer_id = c2.id and x.kind = 'email' and x.is_primary and x.deleted_at is null
      where c2.id = ${customerId}
    ) p
    where c.id = p.customer_id and c.workspace_id = ${workspaceId} and c.erased_at is null
  `;
}

/** Re-establish one primary per kind (oldest row wins) and resync the mirror —
 *  for callers that removed rows outside the normal endpoints (erasure of a
 *  merged source's stamped rows, the legacy-mobile revert on unmerge). */
export async function repairCustomerContacts(sql: Db, workspaceId: string, customerId: string): Promise<void> {
  for (const kind of CONTACT_KINDS) await ensureOnePrimary(sql, workspaceId, customerId, kind);
  await syncPrimaryMirror(sql, workspaceId, customerId);
}

/** Every email address this customer has held — live and soft-deleted rows,
 *  rows a merge re-homed onto a survivor, and the scalar — for the GDPR paths
 *  that must span ALL of them (inbox redaction, the subject-access bundle). */
export async function emailAddressesHeldBy(sql: Db, workspaceId: string, customerId: string): Promise<string[]> {
  const rows = await sql<{ value: string }[]>`
    select distinct lower(value::text) as value from customer_contacts
    where workspace_id = ${workspaceId} and kind = 'email'
      and (customer_id = ${customerId} or merged_from_customer_id = ${customerId})
    union
    select lower(email::text) from customers
    where id = ${customerId} and workspace_id = ${workspaceId} and email is not null
  `;
  return rows.map((r) => r.value);
}

/** If the customer has live rows of `kind` but no primary, promote the oldest. */
async function ensureOnePrimary(sql: Db, workspaceId: string, customerId: string, kind: ContactKind): Promise<void> {
  await sql`
    update customer_contacts set is_primary = true
    where id = (
      select id from customer_contacts
      where workspace_id = ${workspaceId} and customer_id = ${customerId} and kind = ${kind} and deleted_at is null
        and not exists (
          select 1 from customer_contacts p
          where p.customer_id = ${customerId} and p.kind = ${kind} and p.is_primary and p.deleted_at is null
        )
      order by created_at, id
      limit 1
    )
  `;
}

/**
 * Lock the customers row (lock order: customers FIRST), refuse the states the
 * contact endpoints must never write to, and heal. Returns the row.
 */
async function lockCustomerForContacts(tx: Db, workspaceId: string, customerId: string) {
  const [row] = await tx<{
    id: string; display_id: string; email: string | null; mobile: string | null;
    deleted_at: string | null; erased_at: string | null; merged_into_customer_id: string | null;
  }[]>`
    select id, display_id, email, mobile, deleted_at, erased_at, merged_into_customer_id
    from customers
    where id = ${customerId} and workspace_id = ${workspaceId}
    for update
  `;
  if (!row || row.deleted_at) throw new ContactError(404, 'customer_not_found', 'Customer not found');
  if (row.erased_at) throw new ContactError(409, 'erased', "This profile's personal data has been erased");
  if (row.merged_into_customer_id) {
    throw new ContactError(409, 'merged', 'This profile is merged into another — edit the survivor instead');
  }
  await ensurePrimaryContacts(tx, { workspaceId, customerId, email: row.email, mobile: row.mobile });
  return row;
}

// PG 23505 → the specific 409 the SPA can act on. Anything else is rethrown.
async function mapUniqueViolation(
  sql: Db, err: unknown, workspaceId: string, kind: ContactKind, value: string, customerId: string,
): Promise<unknown> {
  const e = err as { code?: string; constraint_name?: string } | null;
  if (!e || e.code !== '23505') return err;
  switch (e.constraint_name) {
    case 'customer_contacts_per_customer_unique':
      return new ContactError(409, 'contact_exists', 'This address is already on this profile');
    case 'customer_contacts_one_primary':
      return new ContactError(409, 'primary_conflict', 'This profile already has a primary of that kind — retry');
    case 'customer_contacts_email_unique':
    case 'customers_workspace_email_unique': {
      // An address held by another live profile is a MERGE candidate, not an
      // error to swallow — name the holder so the UI can offer the merge.
      const [owner] = await sql<{ id: string; display_id: string }[]>`
        select c.id, c.display_id
        from customers c
        left join customer_contacts cc
          on cc.customer_id = c.id and cc.kind = ${kind} and cc.value = ${value} and cc.deleted_at is null
        where c.workspace_id = ${workspaceId} and c.deleted_at is null and c.id <> ${customerId}
          and (cc.id is not null or (${kind} = 'email' and c.email = ${value}))
        limit 1
      `;
      return new ContactError(409, 'contact_in_use',
        owner ? `This ${kind} already belongs to ${owner.display_id} — merge the profiles instead`
              : `This ${kind} already belongs to another profile`,
        { customer_id: owner?.id ?? null, display_id: owner?.display_id ?? null });
    }
    default:
      return err;
  }
}

// ─── Mutations (each opens its own transaction) ──────────────────────────────

export async function addContact(
  sql: postgres.Sql<{}>,
  args: { workspaceId: string; customerId: string; kind: ContactKind; value: unknown; primary?: boolean },
): Promise<{ contact: ContactOut; contacts: CustomerContacts }> {
  const { workspaceId, customerId, kind } = args;
  const value = normalizeContactValue(kind, args.value);
  if (!value) throw new ContactError(400, 'invalid_value', 'A non-empty value is required');

  let created: ContactRow;
  try {
    created = await sql.begin(async (tx) => {
      await lockCustomerForContacts(tx, workspaceId, customerId);
      if (kind === 'email') {
        // Cross-profile check that also sees a LEGACY holder (scalar, no row
        // yet) via the scalar fallback. No heal here: healing ANOTHER profile
        // while holding this one's row lock would invert the merge's sorted-id
        // lock order (FK key-share on the other customers row) — the unique
        // index below backstops the race instead.
        const holder = await resolveCustomerByContact(tx, workspaceId, 'email', value);
        // Same profile → contact_exists here, deterministically: a same-profile
        // duplicate also violates the workspace-wide email index, and Postgres
        // may report that one first, which would read as another profile's.
        if (holder && holder.id === customerId) {
          throw new ContactError(409, 'contact_exists', 'This address is already on this profile');
        }
        if (holder && holder.id !== customerId && holder.merged_into_customer_id === customerId) {
          // The holder is a duplicate ALREADY merged into this profile (a
          // pre-contacts merge never copied email, so the source kept the
          // address). "Merge the profiles instead" would be a dead end — adopt
          // the row onto the survivor exactly as a post-contacts merge would
          // have: stamped, so unmerge still gives it back.
          const [adopted] = await tx<ContactRow[]>`
            update customer_contacts set
              customer_id = ${customerId},
              merged_from_customer_id = ${holder.id},
              primary_before_merge = is_primary,
              is_primary = false
            where workspace_id = ${workspaceId} and customer_id = ${holder.id} and kind = 'email'
              and value = ${value} and deleted_at is null
            returning ${tx.unsafe(CONTACT_COLS)}
          `;
          // Scalar-only duplicate (never healed): create the stamped row here.
          const row = adopted ?? (await tx<ContactRow[]>`
            insert into customer_contacts
              (workspace_id, customer_id, kind, value, is_primary, merged_from_customer_id, primary_before_merge)
            values (${workspaceId}, ${customerId}, 'email', ${value}, false, ${holder.id}, true)
            returning ${tx.unsafe(CONTACT_COLS)}
          `)[0];
          // The duplicate's scalar (a pre-contacts merge left it in place) would
          // collide with this profile's mirror on a later set-primary — release
          // it; the duplicate's display now derives from the stamped row.
          await tx`
            update customers set email = null
            where id = ${holder.id} and workspace_id = ${workspaceId} and email = ${value}
          `;
          if (args.primary) {
            await tx`
              update customer_contacts set is_primary = false
              where customer_id = ${customerId} and kind = 'email' and is_primary and deleted_at is null
            `;
            await tx`update customer_contacts set is_primary = true where id = ${row.id}`;
            row.is_primary = true;
          }
          await syncPrimaryMirror(tx, workspaceId, customerId);
          return row;
        }
        if (holder && holder.id !== customerId) {
          const [owner] = await tx<{ display_id: string }[]>`
            select display_id from customers where id = ${holder.id} and workspace_id = ${workspaceId}
          `;
          throw new ContactError(409, 'contact_in_use',
            `This email already belongs to ${owner?.display_id ?? 'another profile'} — merge the profiles instead`,
            { customer_id: holder.id, display_id: owner?.display_id ?? null });
        }
      }
      const [existingPrimary] = await tx<{ id: string }[]>`
        select id from customer_contacts
        where customer_id = ${customerId} and kind = ${kind} and is_primary and deleted_at is null
      `;
      // The first address of a kind is the primary by definition.
      const makePrimary = Boolean(args.primary) || !existingPrimary;
      if (makePrimary && existingPrimary) {
        await tx`update customer_contacts set is_primary = false where id = ${existingPrimary.id}`;
      }
      const [row] = await tx<ContactRow[]>`
        insert into customer_contacts (workspace_id, customer_id, kind, value, is_primary)
        values (${workspaceId}, ${customerId}, ${kind}, ${value}, ${makePrimary})
        returning ${tx.unsafe(CONTACT_COLS)}
      `;
      if (makePrimary) await syncPrimaryMirror(tx, workspaceId, customerId);
      return row;
    });
  } catch (err) {
    throw await mapUniqueViolation(sql, err, workspaceId, kind, value, customerId);
  }
  return { contact: toOut(created), contacts: await contactsFor(sql, workspaceId, customerId) };
}

export async function removeContact(
  sql: postgres.Sql<{}>,
  args: { workspaceId: string; customerId: string; contactId: string },
): Promise<{ removed: { id: string; kind: ContactKind }; contacts: CustomerContacts }> {
  const { workspaceId, customerId, contactId } = args;
  const removed = await sql.begin(async (tx) => {
    await lockCustomerForContacts(tx, workspaceId, customerId);
    const [row] = await tx<{ id: string; kind: ContactKind; is_primary: boolean; merged_from_customer_id: string | null }[]>`
      select id, kind, is_primary, merged_from_customer_id from customer_contacts
      where id = ${contactId} and customer_id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
      for update
    `;
    if (!row) throw new ContactError(404, 'contact_not_found', 'Contact not found');
    // A row that arrived via merge must stay live so unmerge can restore it —
    // unless its source has since been soft-deleted (allowed by DELETE
    // /customers/:id), which makes unmerge impossible: the row is then simply
    // the survivor's own and must be removable, or the address is stuck forever.
    const liveSources = new Set((await tx<{ id: string }[]>`
      select s.id from customers s
      join customer_contacts x on x.merged_from_customer_id = s.id
      where x.customer_id = ${customerId} and x.workspace_id = ${workspaceId} and s.deleted_at is null
    `).map((s) => s.id));
    const orphaned = (mergedFrom: string | null) => mergedFrom !== null && !liveSources.has(mergedFrom);
    if (row.merged_from_customer_id && !orphaned(row.merged_from_customer_id)) {
      throw new ContactError(409, 'unmerge_first', 'This address came from a merged duplicate — un-merge to remove it');
    }
    const siblings = await tx<{ id: string; merged_from_customer_id: string | null }[]>`
      select id, merged_from_customer_id from customer_contacts
      where customer_id = ${customerId} and kind = ${row.kind} and deleted_at is null and id <> ${row.id}
    `;
    // The agent chooses the new primary; we never guess it on a delete.
    if (row.is_primary && siblings.length) {
      throw new ContactError(409, 'set_primary_first', 'Set another address as primary before removing this one');
    }
    // Email is the identity key (inbound, portal, CSAT, Maestro lookup). A
    // profile must keep at least one email it OWNS — a duplicate's address
    // parked on a survivor doesn't count (unmerge would leave it with none),
    // unless that duplicate is gone for good (orphaned, see above).
    const owned = (s: { merged_from_customer_id: string | null }) => !s.merged_from_customer_id || orphaned(s.merged_from_customer_id);
    if (row.kind === 'email' && !siblings.some(owned)) {
      throw new ContactError(409, 'last_email', 'A profile must keep at least one email address');
    }
    await tx`update customer_contacts set deleted_at = now() where id = ${row.id}`;
    await syncPrimaryMirror(tx, workspaceId, customerId);
    return { id: row.id, kind: row.kind };
  });
  return { removed, contacts: await contactsFor(sql, workspaceId, customerId) };
}

export async function setPrimaryContact(
  sql: postgres.Sql<{}>,
  args: { workspaceId: string; customerId: string; contactId: string },
): Promise<{ contact: { id: string; kind: ContactKind; value: string }; contacts: CustomerContacts }> {
  const { workspaceId, customerId, contactId } = args;
  let target: { id: string; kind: ContactKind; value: string };
  try {
    target = await sql.begin(async (tx) => {
      await lockCustomerForContacts(tx, workspaceId, customerId);
      const [row] = await tx<{ id: string; kind: ContactKind; value: string; is_primary: boolean }[]>`
        select id, kind, value::text as value, is_primary from customer_contacts
        where id = ${contactId} and customer_id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
        for update
      `;
      if (!row) throw new ContactError(404, 'contact_not_found', 'Contact not found');
      if (!row.is_primary) {
        // Two statements: the one-primary index is checked per row.
        await tx`
          update customer_contacts set is_primary = false
          where customer_id = ${customerId} and kind = ${row.kind} and is_primary and deleted_at is null
        `;
        await tx`update customer_contacts set is_primary = true where id = ${row.id}`;
      }
      await syncPrimaryMirror(tx, workspaceId, customerId);
      return { id: row.id, kind: row.kind, value: row.value };
    });
  } catch (err) {
    // The mirror write can trip customers_workspace_email_unique against a
    // legacy scalar on another profile — surface it as the merge candidate.
    if ((err as { code?: string })?.code === '23505') {
      const [row] = await sql<{ kind: ContactKind; value: string }[]>`
        select kind, value::text as value from customer_contacts where id = ${contactId}
      `;
      throw await mapUniqueViolation(sql, err, workspaceId, row?.kind ?? 'email', row?.value ?? '', customerId);
    }
    throw err;
  }
  return { contact: target, contacts: await contactsFor(sql, workspaceId, customerId) };
}

// ─── Merge / unmerge (called INSIDE the merge transaction, customers locked) ──

/**
 * Move the source's live rows onto the survivor, stamped for unmerge. They
 * arrive non-primary unless the survivor has no primary of that kind — then
 * the source's primary is promoted (which reproduces what the old scalar
 * backfill did for `mobile`). A value the survivor already holds live can't
 * move as a live row (per-customer index), so it is PARKED soft-deleted with
 * the stamp; unmerge revives it. Mirrors: source first (releases its email),
 * then survivor (may now claim it) — that order matters for the scalar index.
 */
export async function moveContactsForMerge(
  tx: Db,
  workspaceId: string,
  source: CustomerScalars,
  primary: CustomerScalars,
): Promise<{ moved: number }> {
  await ensurePrimaryContacts(tx, { workspaceId, customerId: source.id, email: source.email, mobile: source.mobile });
  await ensurePrimaryContacts(tx, { workspaceId, customerId: primary.id, email: primary.email, mobile: primary.mobile });

  let moved = 0;
  for (const kind of CONTACT_KINDS) {
    const [survivorPrimary] = await tx<{ id: string }[]>`
      select id from customer_contacts
      where customer_id = ${primary.id} and kind = ${kind} and is_primary and deleted_at is null
    `;
    const promote = !survivorPrimary;
    const rows = await tx<{ id: string }[]>`
      update customer_contacts s set
        customer_id = ${primary.id},
        merged_from_customer_id = ${source.id},
        primary_before_merge = s.is_primary,
        deleted_at = case when exists (
          select 1 from customer_contacts p
          where p.customer_id = ${primary.id} and p.kind = s.kind and p.value = s.value and p.deleted_at is null
        ) then now() else null end,
        is_primary = case when exists (
          select 1 from customer_contacts p
          where p.customer_id = ${primary.id} and p.kind = s.kind and p.value = s.value and p.deleted_at is null
        ) then false else (${promote} and s.is_primary) end
      where s.workspace_id = ${workspaceId} and s.customer_id = ${source.id} and s.kind = ${kind} and s.deleted_at is null
      returning s.id
    `;
    moved += rows.length;
    // The source's primary may have been the parked duplicate — make sure the
    // survivor still ends up with exactly one primary of this kind.
    await ensureOnePrimary(tx, workspaceId, primary.id, kind);
  }
  await syncPrimaryMirror(tx, workspaceId, source.id);
  await syncPrimaryMirror(tx, workspaceId, primary.id);
  return { moved };
}

/**
 * Put the stamped rows back on the source with the primary flag they held,
 * reviving any parked duplicates, then re-establish one primary per kind on
 * both sides. Mirrors: survivor first (releases the address), then source.
 * Heals both profiles first so a pre-contacts merge (nothing stamped) leaves
 * both mirrors exactly as they were.
 */
export async function restoreContactsForUnmerge(
  tx: Db,
  workspaceId: string,
  sourceId: string,
  primaryId: string,
): Promise<{ restored: number }> {
  const both = await tx<CustomerScalars[]>`
    select id, merged_into_customer_id, email, mobile from customers
    where id in (${sourceId}, ${primaryId}) and workspace_id = ${workspaceId}
  `;
  for (const c of both) {
    await ensurePrimaryContacts(tx, { workspaceId, customerId: c.id, email: c.email, mobile: c.mobile }, { allowMerged: true });
  }
  const rows = await tx<{ id: string }[]>`
    update customer_contacts set
      customer_id = ${sourceId},
      merged_from_customer_id = null,
      is_primary = primary_before_merge,
      primary_before_merge = false,
      deleted_at = null
    where workspace_id = ${workspaceId} and customer_id = ${primaryId} and merged_from_customer_id = ${sourceId}
    returning id
  `;
  for (const kind of CONTACT_KINDS) {
    await ensureOnePrimary(tx, workspaceId, primaryId, kind);
    await ensureOnePrimary(tx, workspaceId, sourceId, kind);
  }
  await syncPrimaryMirror(tx, workspaceId, primaryId);
  await syncPrimaryMirror(tx, workspaceId, sourceId);
  return { restored: rows.length };
}

// ─── Read shapes ─────────────────────────────────────────────────────────────

function toOut(r: ContactRow, opts: { isPrimary?: boolean; onSurvivor?: boolean } = {}): ContactOut {
  return {
    id: r.id,
    value: r.value,
    is_primary: opts.isPrimary ?? r.is_primary,
    bounce_state: r.bounce_state,
    bounce_count: r.bounce_count,
    bounce_last_at: r.bounce_last_at,
    merged_from_customer_id: opts.onSurvivor ? null : r.merged_from_customer_id,
    on_survivor: Boolean(opts.onSurvivor),
  };
}

export interface ContactIndex {
  own: Map<string, ContactRow[]>;        // live rows by customer_id
  fromSource: Map<string, ContactRow[]>; // stamped rows (any deleted_at) by merged_from_customer_id
}

/** Every row GET /customers needs for a workspace, in one query. */
export async function listWorkspaceContacts(sql: Db, workspaceId: string): Promise<ContactIndex> {
  const rows = await sql<ContactRow[]>`
    select ${sql.unsafe(CONTACT_COLS)} from customer_contacts
    where workspace_id = ${workspaceId}
      and (deleted_at is null or merged_from_customer_id is not null)
    order by created_at, id
  `;
  return indexContacts(rows);
}

export function indexContacts(rows: ContactRow[]): ContactIndex {
  const own = new Map<string, ContactRow[]>();
  const fromSource = new Map<string, ContactRow[]>();
  for (const r of rows) {
    if (!r.deleted_at) (own.get(r.customer_id) ?? own.set(r.customer_id, []).get(r.customer_id)!).push(r);
    if (r.merged_from_customer_id) {
      (fromSource.get(r.merged_from_customer_id) ?? fromSource.set(r.merged_from_customer_id, []).get(r.merged_from_customer_id)!).push(r);
    }
  }
  return { own, fromSource };
}

/**
 * The wire shape for one customer. Own live rows win; a merged-away profile
 * with none shows the rows the merge re-homed onto its survivor (its own
 * addresses, displayed with the primary flag they held); a legacy row with a
 * scalar and no contact rows shows a synthesised primary from the scalar so
 * nothing goes blank before the first write heals it.
 */
export function buildCustomerContacts(customer: CustomerScalars, idx: ContactIndex): CustomerContacts {
  const own = idx.own.get(customer.id) ?? [];
  const derived = customer.merged_into_customer_id ? (idx.fromSource.get(customer.id) ?? []) : [];
  const pick = (kind: ContactKind): ContactOut[] => {
    const mine = own.filter((r) => r.kind === kind).map((r) => toOut(r));
    if (mine.length) return mine;
    const theirs = derived.filter((r) => r.kind === kind).map((r) => toOut(r, { isPrimary: r.primary_before_merge, onSurvivor: true }));
    if (theirs.length) return theirs;
    const scalar = kind === 'email' ? customer.email : customer.mobile;
    if (!scalar) return [];
    return [{
      id: null, value: scalar, is_primary: true,
      bounce_state: kind === 'email' ? (customer.email_bounce_state ?? 'none') : 'none',
      bounce_count: kind === 'email' ? (customer.email_bounce_count ?? 0) : 0,
      bounce_last_at: kind === 'email' ? (customer.email_last_bounce_at ?? null) : null,
      merged_from_customer_id: null, on_survivor: false,
    }];
  };
  const emails = pick('email');
  const mobiles = pick('mobile');
  return {
    email: emails.find((e) => e.is_primary)?.value ?? emails[0]?.value ?? null,
    mobile: mobiles.find((m) => m.is_primary)?.value ?? mobiles[0]?.value ?? null,
    emails,
    mobiles,
  };
}

/** One customer's wire shape (contact endpoints, merge/unmerge responses). */
export async function contactsFor(sql: Db, workspaceId: string, customerId: string): Promise<CustomerContacts> {
  const [cust] = await sql<CustomerScalars[]>`
    select id, merged_into_customer_id, email, mobile, email_bounce_state, email_bounce_count, email_last_bounce_at
    from customers where id = ${customerId} and workspace_id = ${workspaceId}
  `;
  if (!cust) return { email: null, mobile: null, emails: [], mobiles: [] };
  const rows = await sql<ContactRow[]>`
    select ${sql.unsafe(CONTACT_COLS)} from customer_contacts
    where workspace_id = ${workspaceId}
      and (customer_id = ${customerId} or merged_from_customer_id = ${customerId})
      and (deleted_at is null or merged_from_customer_id is not null)
    order by created_at, id
  `;
  return buildCustomerContacts(cust, indexContacts(rows));
}
