// One-off: convert message bodies that were stored as raw inbound HTML (before
// pickBody converted HTML to text) into readable plain text.
//
// Two tables hold inbound bodies and both are rewritten:
//   - ticket_messages (customer-role rows only — agent replies and notes are
//     never inbound HTML; a customer who typed "<3" is left alone because the
//     detector requires a tag name right after the "<")
//   - inbox_messages (the inbound audit row; the original HTML is copied into
//     body_html first when that column is still empty)
// A body that converts to nothing (Gmail's `<div dir="auto"></div>`) becomes
// the same '(empty body)' placeholder the inbound path uses.
//
// Side effects handled inside the one transaction:
//   - bump_ticket_on_message (AFTER UPDATE on ticket_messages) and
//     set_updated_at (BEFORE UPDATE on tickets) are disabled for the duration,
//     so months-old tickets don't jump to the top of the activity-sorted list
//     and every polling client's /sync cursor doesn't re-fetch them.
//   - changed messages get sentiment = null (the old score was over markup)
//     and, where that message is the ticket's latest customer message, the
//     denormalised tickets.latest_customer_sentiment is cleared too.
//
// Before anything is written, every candidate row's current body is dumped to
// a JSON snapshot in the OS temp dir (dry run AND apply) so a rewrite can be
// reverted by hand if the converter turns out to be wrong for some mail.
//
// Usage (from api/):
//   bun scripts/backfill-html-bodies.ts            # dry run: prints what WOULD change
//   bun scripts/backfill-html-bodies.ts --apply    # performs the update in one transaction
// Requires DATABASE_URL in api/.env (or the environment). Uses the same ssl
// convention as lib/db.ts: TLS unless the URL says sslmode=disable.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { htmlToText } from '../src/lib/html-text.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('✗ Need DATABASE_URL in api/.env');
  process.exit(1);
}
const apply = process.argv.includes('--apply');
const sql = postgres(url, { ssl: url.includes('sslmode=disable') ? false : 'require', max: 1, prepare: false });

// Postgres ARE. Matches a body that STARTS with a comment, doctype, or any
// element tag ("<div dir", "<p>", "<br/>"); "<3 you" and "a < b" do not match.
// \s and \y are Postgres escapes (\b would be a literal backspace).
const HTML_START = String.raw`^\s*<(!--|!doctype\y|[a-z][a-z0-9]*(\s|/?>))`;

type Change = { table: 'ticket_messages' | 'inbox_messages'; id: string; ticket_id: string | null; created_at: string | null; oldBody: string; next: string; body_html: string | null };

const ticketRows = await sql<{ id: string; ticket_id: string; created_at: string; body: string }[]>`
  select id, ticket_id, created_at::text, body
  from ticket_messages
  where role = 'customer' and deleted_at is null and body ~* ${HTML_START}
  order by created_at
`;
const inboxRows = await sql<{ id: string; body: string; body_html: string | null }[]>`
  select id, body, body_html
  from inbox_messages
  where body ~* ${HTML_START}
  order by received_at
`;

const changes: Change[] = [];
for (const r of ticketRows) {
  const next = htmlToText(r.body) || '(empty body)';
  if (next !== r.body) changes.push({ table: 'ticket_messages', id: r.id, ticket_id: r.ticket_id, created_at: r.created_at, oldBody: r.body, next, body_html: null });
}
for (const r of inboxRows) {
  const next = htmlToText(r.body) || '(empty body)';
  if (next !== r.body) changes.push({ table: 'inbox_messages', id: r.id, ticket_id: null, created_at: null, oldBody: r.body, next, body_html: r.body_html });
}

console.log(
  `${ticketRows.length} ticket_messages + ${inboxRows.length} inbox_messages candidate row(s); ${changes.length} would change.` +
  (apply ? '' : ' (dry run — pass --apply to write)'),
);
for (const c of changes) {
  const preview = c.next.replace(/\s+/g, ' ').slice(0, 80);
  console.log(`  ${c.table.padEnd(15)} ${c.id}${c.ticket_id ? `  ticket=${c.ticket_id}` : ''}  ${c.oldBody.length} chars -> "${preview}${c.next.length > 80 ? '…' : ''}"`);
}

if (changes.length) {
  const snapshot = join(tmpdir(), `backfill-html-bodies-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(snapshot, JSON.stringify(changes.map(({ table, id, oldBody, body_html }) => ({ table, id, body: oldBody, body_html })), null, 2));
  console.log(`Snapshot of current bodies: ${snapshot}`);
}

if (apply && changes.length) {
  await sql.begin(async (tx) => {
    // Transactional DDL: both re-enable automatically on rollback, and we
    // re-enable explicitly before commit. Needs table ownership.
    await tx`alter table ticket_messages disable trigger bump_ticket_on_message`;
    await tx`alter table tickets disable trigger set_updated_at`;
    for (const c of changes) {
      if (c.table === 'ticket_messages') {
        await tx`update ticket_messages set body = ${c.next}, sentiment = null where id = ${c.id}`;
        await tx`
          update tickets set latest_customer_sentiment = null
          where id = ${c.ticket_id} and latest_customer_message_at = ${c.created_at}::timestamptz`;
      } else {
        await tx`
          update inbox_messages
          set body = ${c.next}, body_html = coalesce(body_html, ${c.oldBody})
          where id = ${c.id}`;
      }
    }
    await tx`alter table tickets enable trigger set_updated_at`;
    await tx`alter table ticket_messages enable trigger bump_ticket_on_message`;
  });
  console.log(`✓ Updated ${changes.length} row(s).`);
}

await sql.end();
