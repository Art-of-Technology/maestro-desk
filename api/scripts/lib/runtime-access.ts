import type { Sql } from 'postgres';

// Explicit operator action only: this is never called by migrations or the API.
export async function configureRuntimeAccess(sql:Sql,role:string,database:string,apply=false) {
  return sql.begin(async tx=>{
    await tx`set local statement_timeout='30s'`;
    await tx`set local lock_timeout='3s'`;
    const [db]=await tx`select current_database() name,current_user operator`;
    if(db.name!==database)throw Error('Database confirmation does not match');
    const [owner]=await tx`select pg_get_userbyid(relowner) name from pg_class where oid='public.audit_events'::regclass`;
    if(owner.name!==db.operator)throw Error('Use the migration/table-owner login so default privileges apply to future migrations');
    const [candidate]=await tx`select oid,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolcanlogin
      from pg_roles where rolname=${role}`;
    if(!candidate || !candidate.rolcanlogin || candidate.rolsuper || candidate.rolcreaterole || candidate.rolcreatedb
      || candidate.rolreplication || candidate.rolbypassrls)throw Error('Use a separate existing unprivileged login');
    const [unsafe]=await tx`select
      exists(select 1 from pg_auth_members where member=${candidate.oid}) as memberships,
      exists(select 1 from pg_class where relowner=${candidate.oid}) as owns_relations,
      exists(select 1 from pg_proc where proowner=${candidate.oid}) as owns_functions,
      exists(select 1 from pg_namespace where nspowner=${candidate.oid}) as owns_schema,
      exists(select 1 from pg_database where datdba=${candidate.oid}) as owns_database`;
    if(Object.values(unsafe).some(Boolean))throw Error('Runtime login must have no role memberships or owned objects');
    const definers=await tx`select p.proname,format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) signature
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef`;
    const approved=['provision_brand','seed_default_roles','deduct_ai_credits','audit_events_verify_checked'];
    if(definers.some(f=>!approved.includes(f.proname)))throw Error('An unreviewed privileged function requires operator review');
    const tables=await tx`select tablename from pg_tables where schemaname='public' order by tablename`;
    const protectedTables=['audit_events','audit_verify_checkpoints','schema_migrations','audit_repair_receipts'];
    if(apply) {
      await tx`revoke create,temporary on database ${tx(database)} from public,${tx(role)}`;
      await tx`revoke all on schema public from public,${tx(role)}`;
      await tx`grant usage on schema public to ${tx(role)}`;
      await tx`revoke all on all tables in schema public from public,${tx(role)}`;
      await tx`revoke all on all sequences in schema public from public,${tx(role)}`;
      await tx`revoke all on all functions in schema public from public,${tx(role)}`;
      for(const table of tables.filter(t=>!protectedTables.includes(t.tablename)))
        await tx`grant select,insert,update,delete on table public.${tx(table.tablename)} to ${tx(role)}`;
      await tx`grant select,insert on audit_events to ${tx(role)}`;
      await tx`grant select on audit_verify_checkpoints,schema_migrations to ${tx(role)}`;
      await tx`grant usage,select on all sequences in schema public to ${tx(role)}`;
      await tx`grant execute on all functions in schema public to ${tx(role)}`;
      await tx`revoke execute on function audit_events_verify_incremental(uuid) from ${tx(role)}`;
      for(const fn of definers)
        await tx`alter function ${tx.unsafe(fn.signature)} set search_path=pg_catalog,public,pg_temp`;
      // New functions are closed by default. Re-run this reviewed grant inventory
      // after migrations; do not grant unrestricted future objects to the runtime.
      await tx`alter default privileges in schema public revoke execute on functions from public`;
    }
    return {database:db.name,role,mode:apply?'applied':'preview',tables:tables.length,privilegedFunctions:definers.map(f=>f.proname)};
  });
}
