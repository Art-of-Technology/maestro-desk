// One-off: convert ticket_messages bodies that were stored as raw inbound HTML
// (before pickBody converted HTML to text) into readable plain text.
//
// Only customer-role rows are candidates, and only those whose body STARTS
// with an HTML document/block tag — a customer who typed "<3" is left alone.
// A body that converts to nothing (e.g. Gmail's `<div dir="auto"></div>`)
// becomes the same '(empty body)' placeholder the inbound path uses.
// Changed rows get their per-message sentiment reset to null, since the old
// score (if any) was computed over markup; agents can re-score from the UI.
//
// Usage (from api/):
//   bun scripts/backfill-html-bodies.ts            # dry run: prints what WOULD change
//   bun scripts/backfill-html-bodies.ts --apply    # performs the update in one transaction
// Requires DATABASE_URL in api/.env.
import postgres from 'postgres';
import { htmlToText } from '../src/lib/html-text.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('✗ Need DATABASE_URL in api/.env');
  process.exit(1);
}
const apply = process.argv.includes('--apply');
const sql = postgres(url, { max: 1 });

// Postgres ARE: \y is a word boundary (\b would be a literal backspace).
const HTML_START = String.raw`^\s*<(!doctype|html|head|body|div|p|span|table|br)\y`;

type Row = { id: string; ticket_id: string; body: string; sentiment: string | null };

const rows = await sql<Row[]>`
  select id, ticket_id, body, sentiment
  from ticket_messages
  where role = 'customer'
    and deleted_at is null
    and body ~* ${HTML_START}
  order by created_at
`;

const changes: { id: string; ticket_id: string; oldLen: number; next: string }[] = [];
for (const r of rows) {
  const next = htmlToText(r.body) || '(empty body)';
  if (next !== r.body) changes.push({ id: r.id, ticket_id: r.ticket_id, oldLen: r.body.length, next });
}

console.log(`${rows.length} candidate row(s); ${changes.length} would change.${apply ? '' : ' (dry run — pass --apply to write)'}`);
for (const c of changes) {
  const preview = c.next.replace(/\s+/g, ' ').slice(0, 80);
  console.log(`  ${c.id}  ticket=${c.ticket_id}  ${c.oldLen} chars -> "${preview}${c.next.length > 80 ? '…' : ''}"`);
}

if (apply && changes.length) {
  await sql.begin(async (tx) => {
    for (const c of changes) {
      await tx`update ticket_messages set body = ${c.next}, sentiment = null where id = ${c.id}`;
    }
  });
  console.log(`✓ Updated ${changes.length} row(s).`);
}

await sql.end();
