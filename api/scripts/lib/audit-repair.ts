import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';

// Only fixed operator-facing messages use this type. Database/provider errors
// still pass through safeError at the CLI boundary.
export class RepairRefusal extends Error {}

const ids = z.array(z.string().uuid()).max(500);
const requestSchema = z
  .object({
    operationId: z.string().uuid(),
    database: z.string().min(1).max(63),
    workspaceId: z.string().uuid(),
    selectedIds: ids.min(1),
    excludedIds: ids,
    // Opaque references to separately reviewed records, never legal/customer text.
    decisionId: z.string().uuid(),
    holdReviewId: z.string().uuid(),
    holds: z.literal('none_in_workspace'),
  })
  .strict();
export type RepairRequest = z.infer<typeof requestSchema>;
export function parseRepairRequest(input: unknown): RepairRequest {
  const r = requestSchema.parse(input);
  r.selectedIds = r.selectedIds.map((v) => v.toLowerCase()).sort();
  r.excludedIds = r.excludedIds.map((v) => v.toLowerCase()).sort();
  if (
    new Set([...r.selectedIds, ...r.excludedIds]).size !==
    r.selectedIds.length + r.excludedIds.length
  )
    throw new RepairRefusal(
      'Repair scope contains duplicate or overlapping row IDs',
    );
  return r;
}
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const snapshotSchema = z
  .object({
    databaseIdentity: digest,
    policyHash: digest,
    chainRows: z.number().int().min(1).max(5000),
    oldTail: z
      .object({ seq: z.string().regex(/^\d+$/), hash: digest })
      .strict(),
    targets: z
      .array(
        z
          .object({ id: z.string().uuid(), subjectId: z.string().uuid() })
          .strict(),
      )
      .max(500),
  })
  .strict();
const proposalSchema = z
  .object({
    version: z.literal(1),
    request: requestSchema,
    snapshot: snapshotSchema,
    proposalHash: digest,
  })
  .strict();
export type RepairProposal = z.infer<typeof proposalSchema>;
export function parseRepairProposal(input: unknown): RepairProposal {
  const p = proposalSchema.parse(input);
  p.request = parseRepairRequest(p.request);
  if (
    p.proposalHash !==
    hash({ version: p.version, request: p.request, snapshot: p.snapshot })
  )
    throw new RepairRefusal(
      'Proposal fingerprint does not match; create a new preview',
    );
  return p;
}

async function setup(tx: TransactionSql, database: string) {
  await tx`set local search_path=pg_catalog,public,pg_temp`;
  await tx`set local timezone='UTC'`;
  await tx`set local datestyle='ISO, YMD'`;
  await tx`set local statement_timeout='10s'`;
  await tx`set local transaction_timeout='30s'`;
  await tx`set local lock_timeout='1s'`;
  const [identity] =
    await tx`select current_database() name,current_user operator,
    pg_get_userbyid(relowner) owner from pg_class where oid='public.audit_events'::regclass`;
  if (identity.name !== database || identity.operator !== identity.owner)
    throw new RepairRefusal(
      'Confirmed database and table-owner login are required',
    );
}

async function snapshot(tx: TransactionSql, r: RepairRequest) {
  const rows =
    await tx`select id,seq::text,encode(row_hash,'hex') hash from public.audit_events
    where workspace_id=${r.workspaceId} order by seq limit 5001`;
  if (!rows.length || rows.length > 5000)
    throw new RepairRefusal(
      'Repair requires a nonempty chain of at most 5000 rows',
    );
  const present = new Set(rows.map((row) => row.id));
  if ([...r.selectedIds, ...r.excludedIds].some((id) => !present.has(id)))
    throw new RepairRefusal(
      'Every selected and excluded row must belong to the confirmed workspace',
    );
  const verified =
    await tx`select * from public.audit_events_verify(${r.workspaceId})`;
  if (verified.length !== 1 || !verified[0].ok)
    throw new RepairRefusal('Existing audit chain is damaged; repair refused');
  const checkpoint = await tx`select 1 from public.audit_verify_checkpoints cp
    left join public.audit_events a on a.workspace_id=cp.workspace_id and a.seq=cp.last_seq
    where cp.workspace_id=${r.workspaceId} and (a.id is null or a.row_hash is distinct from cp.last_row_hash)`;
  if (checkpoint.length)
    throw new RepairRefusal(
      'Existing checkpoint disagrees with history; repair refused',
    );
  // Establish only a current, workspace-scoped parent. Do not guess from copied
  // metadata, missing targets, player IDs, display labels or another tenant.
  const targets = await tx`select a.id,case a.target_type
    when 'customer' then (select c.id from public.customers c where c.id=a.target_id and c.workspace_id=a.workspace_id)
    when 'ticket' then (select t.customer_id from public.tickets t where t.id=a.target_id and t.workspace_id=a.workspace_id
      and t.pre_merge_customer_id is null and t.merged_into_id is null)
    when 'customer_note' then (select n.customer_id from public.customer_notes n where n.id=a.target_id and n.workspace_id=a.workspace_id
      and n.merged_from_customer_id is null)
    when 'ticket_message' then (select t.customer_id from public.ticket_messages m join public.tickets t
      on t.id=m.ticket_id and t.workspace_id=m.workspace_id where m.id=a.target_id and m.workspace_id=a.workspace_id
      and m.merged_from_id is null and t.pre_merge_customer_id is null and t.merged_into_id is null)
    end as "subjectId" from public.audit_events a where a.workspace_id=${r.workspaceId} and a.id=any(${r.selectedIds}::uuid[]) order by a.id`;
  if (targets.some((t) => !t.subjectId))
    throw new RepairRefusal(
      'Selected target has uncertain ownership; exclude it for separate review',
    );
  const subjects = [...new Set(targets.map((t) => t.subjectId))];
  const unambiguous =
    await tx`select c.id from public.customers c where c.workspace_id=${r.workspaceId}
    and c.id=any(${subjects}::uuid[]) and c.merged_into_customer_id is null and not exists
      (select 1 from public.customer_merges m where m.workspace_id=c.workspace_id
        and (m.source_customer_id=c.id or m.primary_customer_id=c.id))`;
  if (unambiguous.length !== subjects.length)
    throw new RepairRefusal(
      'Selected ownership has merge history or a missing parent; separate review required',
    );
  const [policy] =
    await tx`select encode(sha256(convert_to(pg_get_functiondef('public.audit_metadata_facts(text,jsonb)'::regprocedure),'UTF8')),'hex') hash`;
  const [identity] = await tx`select current_database() name,oid::text,
    inet_server_addr()::text address,inet_server_port() port from pg_database where datname=current_database()`;
  const tail = rows.at(-1)!;
  return snapshotSchema.parse({
    databaseIdentity: hash(identity),
    policyHash: policy.hash,
    chainRows: rows.length,
    oldTail: { seq: tail.seq, hash: tail.hash },
    targets,
  });
}

export async function previewAuditRepair(
  sql: Sql,
  input: unknown,
): Promise<RepairProposal> {
  const request = parseRepairRequest(input);
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    await setup(tx, request.database);
    const data = {
      version: 1 as const,
      request,
      snapshot: await snapshot(tx, request),
    };
    return { ...data, proposalHash: hash(data) };
  });
}

export async function readRepairReceipt(sql: Sql, input: unknown) {
  const p = parseRepairProposal(input);
  return sql.begin('read only', async (tx) => {
    await setup(tx, p.request.database);
    const [saved] =
      await tx`select proposal_hash,receipt from public.audit_repair_receipts where id=${p.request.operationId}`;
    if (saved && saved.proposal_hash !== p.proposalHash)
      throw new RepairRefusal(
        'Operation ID already belongs to a different proposal',
      );
    return saved?.receipt ?? null;
  });
}

export async function applyAuditRepair(sql: Sql, input: unknown) {
  const p = parseRepairProposal(input),
    r = p.request;
  return sql.begin(async (tx) => {
    await setup(tx, r.database);
    // Coordinate with the existing migration runner, then fail fast on every
    // table lock. Never wait for audit exclusivity while holding a workspace
    // advisory lock: an in-flight INSERT can hold the reverse lock order.
    const [lock] =
      await tx`select pg_try_advisory_xact_lock(727573707) acquired`;
    if (!lock.acquired)
      throw new RepairRefusal('Migration or another repair is running');
    await tx`lock table public.audit_events in access exclusive mode nowait`;
    await tx`lock table public.audit_verify_checkpoints in access exclusive mode nowait`;
    await tx`lock table public.customers,public.tickets,public.customer_notes,public.ticket_messages,public.customer_merges in share mode nowait`;
    const [saved] =
      await tx`select proposal_hash,receipt from public.audit_repair_receipts where id=${r.operationId}`;
    if (saved) {
      if (saved.proposal_hash !== p.proposalHash)
        throw new RepairRefusal(
          'Operation ID already belongs to a different proposal',
        );
      return saved.receipt;
    }
    if (hash(await snapshot(tx, r)) !== hash(p.snapshot))
      throw new RepairRefusal(
        'Preview is stale; create and approve a new preview',
      );
    const [guard] =
      await tx`select tgenabled from pg_trigger where tgrelid='public.audit_events'::regclass and tgname='audit_events_no_update'`;
    if (!guard || guard.tgenabled !== 'O')
      throw new RepairRefusal(
        'Audit update guard is not in its expected enabled state',
      );
    await tx`alter table public.audit_events disable trigger audit_events_no_update`;
    // One bounded, server-side statement; no helper granting bypass to the API.
    // Row IDs, sequence, timestamps and attribution remain unchanged. Exclusions
    // keep their content; later links may change as part of the declared transition.
    await tx`with recursive cleaned as materialized (
      select a.*,case when id=any(${r.selectedIds}::uuid[]) then public.audit_metadata_facts(action,metadata) else metadata end new_metadata,
        case when id=any(${r.selectedIds}::uuid[]) then null else actor_ip end new_ip,
        case when id=any(${r.selectedIds}::uuid[]) then null else actor_ua end new_ua
      from public.audit_events a where workspace_id=${r.workspaceId}
    ), chain as (
      select a.id,a.seq,null::bytea previous,public.audit_events_rowhash(null,a.id,a.workspace_id,a.actor_user_id,
        a.new_ip,a.new_ua,a.action,a.target_type,a.target_id,a.new_metadata,a.created_at) hash from cleaned a where seq=1
      union all
      select a.id,a.seq,c.hash,public.audit_events_rowhash(c.hash,a.id,a.workspace_id,a.actor_user_id,
        a.new_ip,a.new_ua,a.action,a.target_type,a.target_id,a.new_metadata,a.created_at)
      from chain c join cleaned a on a.seq=c.seq+1
    ) update public.audit_events a set metadata=d.new_metadata,actor_ip=d.new_ip,actor_ua=d.new_ua,
      prev_hash=c.previous,row_hash=c.hash from chain c join cleaned d on d.id=c.id
      where a.id=c.id and a.workspace_id=${r.workspaceId}`;
    await tx`alter table public.audit_events enable trigger audit_events_no_update`;
    await tx`delete from public.audit_verify_checkpoints where workspace_id=${r.workspaceId}`;
    const full =
      await tx`select * from public.audit_events_verify(${r.workspaceId})`;
    const incremental =
      await tx`select * from public.audit_events_verify_incremental(${r.workspaceId})`;
    if (
      full.length !== 1 ||
      incremental.length !== 1 ||
      !full[0].ok ||
      !incremental[0].ok
    )
      throw new RepairRefusal(
        'Post-repair verification failed; all changes rolled back',
      );
    const [tail] =
      await tx`select seq::text,encode(row_hash,'hex') hash from public.audit_events
      where workspace_id=${r.workspaceId} order by seq desc limit 1`;
    const receipt = {
      version: 1,
      status: 'committed',
      proposal: p,
      newTail: tail,
      completedAt: new Date().toISOString(),
      selectedRows: r.selectedIds.length,
      rehashedRows: p.snapshot.chainRows,
      integrityTransition: true,
    };
    await tx`insert into public.audit_repair_receipts(id,workspace_id,proposal_hash,receipt)
      values(${r.operationId},${r.workspaceId},${p.proposalHash},${tx.json(receipt)})`;
    return receipt;
  });
}
