// Explicit operator action; never invoked by migrations or application startup.
// Preview is the default. UUIDs/counts only: never print subject content.
import { parseArgs } from 'node:util';
import { getDb } from '../src/lib/db.js';
import { eraseCustomer } from '../src/lib/gdpr-erasure.js';
import { safeError } from '../src/lib/diagnostics.js';

const {values}=parseArgs({options:{workspace:{type:'string'},after:{type:'string'},limit:{type:'string',default:'100'},
  apply:{type:'boolean',default:false},confirm:{type:'string'}}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limit=Number(values.limit);
if (!values.workspace || !uuid.test(values.workspace) || (values.after && !uuid.test(values.after)) || !Number.isInteger(limit) || limit<1 || limit>500 ||
  (values.apply && values.confirm!==values.workspace)) {
  throw new Error('Use --workspace UUID [--after UUID] [--limit 1..500]. Applying requires --apply --confirm matching-workspace-UUID.');
}
const sql=getDb();
try {
  const rows=await sql`select id from customers where workspace_id=${values.workspace} and erased_at is not null
    and (${values.after ?? null}::uuid is null or id>${values.after ?? null}::uuid) order by id limit ${limit}`;
  for (const row of rows) {
    const [counts]=await sql`with owned as (select id from tickets where workspace_id=${values.workspace} and customer_id=${row.id})
      select (select count(*)::int from tickets where id in (select id from owned) and (ai_summary is not null or ai_draft_reply is not null)) as legacy_ai_tickets,
        (select count(*)::int from ticket_messages where workspace_id=${values.workspace} and merged_from_id in (select id from owned)
          and ticket_id not in (select id from owned)) as merged_copies,
        (select count(*)::int from time_entries where workspace_id=${values.workspace} and ticket_id in (select id from owned) and note is not null) as time_notes,
        (select count(*)::int from ticket_tags where workspace_id=${values.workspace} and ticket_id in (select id from owned)) as tags,
        (select count(*)::int from ticket_ai_tags where workspace_id=${values.workspace} and ticket_id in (select id from owned)) as ai_tags`;
    if(values.apply) await eraseCustomer({workspaceId:values.workspace,customerId:row.id,requestedByUserId:null});
    console.log(JSON.stringify({customer_id:row.id,mode:values.apply?'applied':'preview',observed_before:counts}));
  }
  console.log(JSON.stringify({processed:rows.length,next_after:rows.at(-1)?.id ?? null,
    more_may_exist:rows.length===limit,scope:'S2 application content; audit history, backups and downstream copies excluded'}));
} catch(error) {
  console.error('Repair stopped; resume after the last successfully reported customer.',safeError(error));
  process.exitCode=1;
} finally {await sql.end();}
