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

// ALTER TABLE … DISABLE TRIGGER takes an ACCESS EXCLUSIVE lock on the table for
// the rest of its transaction, blocking every read and write on ticket_messages
// and tickets. So the work is chunked: each chunk is its own short transaction
// with one set-based UPDATE per table, and the locks are held for milliseconds
// rather than for the whole run. A chunk that fails leaves earlier chunks
// committed — re-running is safe because converted rows no longer match the
// detector.
const CHUNK = 200;

if (apply && changes.length) {
  let done = 0;
  for (let i = 0; i < changes.length; i += CHUNK) {
    const chunk = changes.slice(i, i + CHUNK);
    const tm = chunk.filter((c) => c.table === 'ticket_messages');
    const im = chunk.filter((c) => c.table === 'inbox_messages');
    await sql.begin(async (tx) => {
      if (tm.length) {
        // Transactional DDL: re-enabled automatically on rollback, and
        // explicitly before commit. Needs table ownership.
        await tx`alter table ticket_messages disable trigger bump_ticket_on_message`;
        await tx`alter table tickets disable trigger set_updated_at`;
        await tx`
          update ticket_messages m
          set body = v.next, sentiment = null
          from (select unnest(${tm.map((c) => c.id)}::uuid[]) as id, unnest(${tm.map((c) => c.next)}::text[]) as next) v
          where m.id = v.id`;
        await tx`
          update tickets t
          set latest_customer_sentiment = null
          from (select unnest(${tm.map((c) => c.ticket_id)}::uuid[]) as ticket_id,
                       unnest(${tm.map((c) => c.created_at)}::timestamptz[]) as created_at) v
          where t.id = v.ticket_id and t.latest_customer_message_at = v.created_at`;
        await tx`alter table tickets enable trigger set_updated_at`;
        await tx`alter table ticket_messages enable trigger bump_ticket_on_message`;
      }
      if (im.length) {
        await tx`
          update inbox_messages m
          set body = v.next, body_html = coalesce(m.body_html, m.body)
          from (select unnest(${im.map((c) => c.id)}::uuid[]) as id, unnest(${im.map((c) => c.next)}::text[]) as next) v
          where m.id = v.id`;
      }
    });
    done += chunk.length;
    console.log(`  … ${done}/${changes.length}`);
  }
  console.log(`✓ Updated ${changes.length} row(s).`);
}

await sql.end();
