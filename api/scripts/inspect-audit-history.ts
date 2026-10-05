// Read-only, bounded evidence collection. No apply mode and no personal text output.
import { parseArgs } from 'node:util';
import { getDb } from '../src/lib/db.js';
import { safeError } from '../src/lib/diagnostics.js';

const {values}=parseArgs({options:{workspace:{type:'string'},after:{type:'string',default:'0'},limit:{type:'string',default:'100'}}});
const limit=Number(values.limit);
if(!values.workspace || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(values.workspace)
  || !/^\d{1,18}$/.test(values.after!) || !Number.isInteger(limit) || limit<1 || limit>500) {
  throw Error('Use --workspace UUID [--after sequence] [--limit 1..500]. This command never changes records.');
}
const sql=getDb();
try {
  const report=await sql.begin('isolation level repeatable read read only',async tx=>{
    await tx`set local statement_timeout='30s'`;
    const [privileges]=await tx`select r.rolsuper as superuser,r.rolcreaterole as can_manage_roles,
      pg_has_role(current_user,c.relowner,'USAGE') as acts_as_audit_owner,
      has_table_privilege(current_user,'audit_events','UPDATE') as can_attempt_audit_update
      from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
      where r.rolname=current_user and c.relname='audit_events' and n.nspname='public'`;
    const rows=await tx`select a.id,a.seq::text,
      (a.metadata is distinct from audit_metadata_facts(a.action,a.metadata) or a.actor_ip is not null or a.actor_ua is not null) as needs_review,
      (a.target_type='ticket' and not exists(select 1 from tickets t where t.id=a.target_id and t.workspace_id=a.workspace_id)) as missing_ticket,
      (a.target_type='customer' and not exists(select 1 from customers c where c.id=a.target_id and c.workspace_id=a.workspace_id)) as missing_customer
      from audit_events a where a.workspace_id=${values.workspace} and a.seq>${values.after!}::bigint order by a.seq limit ${limit}`;
    const [tail]=await tx`select seq::text,encode(row_hash,'hex') as hash from audit_events
      where workspace_id=${values.workspace} order by seq desc limit 1`;
    return {workspace_id:values.workspace,mode:'read_only',privileges,tail:tail??null,records:rows,
      next_after:rows.at(-1)?.seq??values.after,more_may_exist:rows.length===limit,
      limitation:'A candidate count is not a legal decision or complete subject attribution. Historical text and chain hashes are unchanged.'};
  });
  console.log(JSON.stringify(report));
} catch(error) {console.error('Audit inspection failed.',safeError(error));process.exitCode=1;}
finally {await sql.end();}
