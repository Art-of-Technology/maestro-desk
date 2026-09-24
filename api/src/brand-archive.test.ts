import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const migration = readFileSync(new URL('../../db/migrations/20260924100000_archive_inactive_brands.sql', import.meta.url), 'utf8');
const targets = [
  ['oh-my-casino-51515fe7', 'Oh My Casino'], ['xtreme-93311046', 'Xtreme'],
  ['casinovi-7b4dc7bc', 'Casinovi'], ['maestro-desk', 'Maestro-Desk'],
];

(process.env.RUN_DB_TESTS ? describe : describe.skip)('archived brands', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: typeof import('./index.js').default;
  let ws: string, user: string, token: string;
  const brandId = randomUUID();
  const run = Date.now();
  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    app = (await import('./index.js')).default;
    const { auth } = await import('./lib/auth.js');
    const session = await auth.api.signUpEmail({ body: { email: `archive-${run}@test.invalid`, password: 'password-12345', name: 'Archive test' } });
    user = session.user.id; token = session.token!;
    const [row] = await sql`select provision_brand('Archive test', ${'archive-' + run}) as id`;
    ws = row.id;
    await sql`update workspaces set maestro_brand_id=${brandId} where id=${ws}`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active)
      select ${ws},${user},id,true from roles where workspace_id=${ws} and name='Admin'`;
  });
  afterAll(async () => {
    if (ws) await sql`delete from workspaces where id=${ws}`;
    if (user) await sql`delete from users where id=${user}`;
  });

  it('exposes the system inbox separately from brands only to platform admins', async () => {
    const headers = { Authorization: `Bearer ${token}` };
    expect((await app.request('/api/v1/god/brands')).status).toBe(401);
    expect((await app.request('/api/v1/god/brands', { headers })).status).toBe(403);
    await sql`update users set is_platform_admin=true where id=${user}`;
    try {
      const response = await app.request('/api/v1/god/brands', { headers });
      expect(response.status).toBe(200);
      const body = await response.json() as { unrouted_workspace_id: string | null; unrouted_outstanding_count: number; brands: { id: string }[] };
      const [bucket] = await sql`select id from workspaces where is_unrouted_bucket=true and deleted_at is null and suspended_at is null`;
      expect(bucket).toBeDefined();
      expect(body.unrouted_workspace_id).toBe(bucket.id);
      expect(body.brands.some((b: { id: string }) => b.id === bucket.id)).toBe(false);
      expect(body.brands.some((b: { id: string }) => b.id === ws)).toBe(true);
      expect((await app.request('/api/v1/tickets', { headers: { ...headers, 'X-Workspace-Id': bucket.id } })).status).toBe(200);
      const [customer] = await sql`insert into customers(workspace_id,display_id,first_name)
        values(${bucket.id},${'M-COUNT-' + run},'Count test') returning id`;
      try {
        const ids: string[] = [];
        for (const [i, status] of ['open', 'pending', 'escalated', 'gdpr', 'resolved', 'closed', 'open', 'open'].entries()) {
          const [ticket] = await sql`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key,
            closure_reason,closed_at,deleted_at,merged_into_id)
            values(${bucket.id},${customer.id},${'TK-COUNT-' + run + '-' + i},'Count test',${status},'normal',
              ${status === 'closed' ? 'spam' : null},${status === 'closed' ? new Date() : null},
              ${i === 6 ? new Date() : null},${i === 7 ? ids[0] : null}) returning id`;
          ids.push(ticket.id);
        }
        const counted = await (await app.request('/api/v1/god/brands', { headers })).json() as typeof body;
        expect(counted.unrouted_outstanding_count).toBe(body.unrouted_outstanding_count + 4);
        await sql`update tickets set status_key='resolved' where id=${ids[0]}`;
        const refreshed = await (await app.request('/api/v1/god/brands', { headers })).json() as typeof body;
        expect(refreshed.unrouted_outstanding_count).toBe(body.unrouted_outstanding_count + 3);
      } finally {
        await sql`delete from tickets where customer_id=${customer.id} and workspace_id=${bucket.id}`;
        await sql`delete from customers where id=${customer.id}`;
      }
    } finally {
      await sql`update users set is_platform_admin=false where id=${user}`;
    }
  });

  it('blocks existing sessions, platform-admin access and Maestro reprovisioning', async () => {
    const headers = { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws };
    expect((await app.request('/api/v1/tickets', { headers })).status).toBe(200);
    await sql`update workspaces set deleted_at=now() where id=${ws}`;
    expect((await app.request('/api/v1/tickets', { headers })).status).toBe(403);
    await sql`update users set is_platform_admin=true where id=${user}`;
    expect((await app.request('/api/v1/tickets', { headers })).status).toBe(403);
    expect((await app.request(`/api/v1/god/brands/${ws}`, { headers })).status).toBe(404);
    expect((await app.request(`/api/v1/god/brands/${ws}`, { headers, method:'PATCH', body: JSON.stringify({suspended_at:null}) })).status).toBe(404);
    const { resolveBrandWorkspace } = await import('./lib/maestro-workspace.js');
    await expect(resolveBrandWorkspace(user, {id:brandId,name:'Archive test'}, 'Admin')).rejects.toThrow('archived');
    const [count] = await sql`select count(*)::int as n from workspaces where maestro_brand_id=${brandId}`;
    expect(count.n).toBe(1);
  });

  it('skips archived email routes, knowledge imports, webhook retries and AI work', async () => {
    await sql`update workspaces set deleted_at=now() where id=${ws}`;
    const domain = `archive-${run}.test`;
    await sql`insert into workspace_email_domains(workspace_id,domain,verified_at) values(${ws},${domain},now())`;
    const { resolveInboundWorkspace } = await import('./lib/inbound-email.js');
    const result = await resolveInboundWorkspace({toDomain:domain});
    expect(result.routed).toBe(false);
    expect(result.workspaceId).not.toBe(ws);
    const [source] = await sql`insert into knowledge_sources(workspace_id,kind,title,locator,fingerprint,auto_refresh)
      values(${ws},'url','Archived','https://example.com','archive',true) returning id`;
    const { refreshKnowledgeSource } = await import('./lib/knowledge-sources.js');
    expect(await refreshKnowledgeSource(ws,source.id,true)).toBe(false);
    const [hook] = await sql`insert into workspace_webhooks(workspace_id,name,url,secret,events,active)
      values(${ws},'Archived','https://example.com/hook','test',array['ticket.created'],true) returning id`;
    const [delivery] = await sql`insert into webhook_deliveries(workspace_id,webhook_id,event,payload,next_attempt_at)
      values(${ws},${hook.id},'ticket.created','{}',now()-interval '1 day') returning id`;
    await (await import('./lib/outgoing-webhooks.js')).processPendingDeliveries();
    const [pending] = await sql`select attempts,state from webhook_deliveries where id=${delivery.id}`;
    expect(pending.attempts).toBe(0); expect(pending.state).toBe('pending');
    await expect((await import('./lib/budget.js')).assertHasBudget(ws)).rejects.toThrow('not found');
  });

  it('does not wake archived tickets or send customer surveys', async () => {
    await sql`update workspaces set deleted_at=now() where id=${ws}`;
    const [customer] = await sql`insert into customers(workspace_id,display_id,first_name)
      values(${ws},'M-SNOOZE','Archived') returning id`;
    const [ticket] = await sql`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key,snoozed_until)
      values(${ws},${customer.id},'TK-SNOOZE','Archived','open','normal',now()-interval '1 day') returning *`;
    await (await import('./lib/snooze-worker.js')).processExpiredSnoozes();
    const cleared = await sql.begin(tx => (import('./lib/ticket-snooze.js')).then(m => m.clearTicketSnooze(tx,
      {workspaceId:ws,ticketId:ticket.id,automatic:true,actorId:null})));
    expect(cleared).toBeNull();
    expect((await sql`select * from tickets where id=${ticket.id}`)[0]).toEqual(ticket);
    await sql`update tickets set status_key='resolved' where id=${ticket.id}`;
    expect(await (await import('./lib/csat-survey.js')).sendCsatSurvey({workspaceId:ws,ticketId:ticket.id}))
      .toEqual({sent:false,reason:'no_workspace'});
    const [saved] = await sql`select csat_send_claim,csat_requested_at from tickets where id=${ticket.id}`;
    expect(saved.csat_send_claim).toBeNull(); expect(saved.csat_requested_at).toBeNull();
  });

  it('archives only the named suspended brands, preserves data and audits once', async () => {
    const rollback = new Error('rollback fixture');
    try {
      await sql.begin(async tx => {
        let [space] = await tx`select * from workspaces where slug='spacecasino'`;
        if (!space) {
          const [made] = await tx`select provision_brand('Space Casino','spacecasino') as id`;
          [space] = await tx`select * from workspaces where id=${made.id}`;
        }
        const ids = [];
        for (const [slug,name] of targets) {
          const [row] = await tx`select provision_brand(${name},${slug}) as id`;
          ids.push(row.id);
          await tx`update workspaces set suspended_at=now() where id=${row.id}`;
          const [customer] = await tx`insert into customers(workspace_id,display_id,first_name)
            values(${row.id},'M-ARCHIVE','Historical customer') returning id`;
          await tx`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key)
            values(${row.id},${customer.id},'TK-ARCHIVE','Historical record','open','normal')`;
        }
        await tx.unsafe(migration);
        await tx.unsafe(migration);
        expect((await tx`select id from workspaces where id in ${tx(ids)} and deleted_at is not null`).length).toBe(4);
        expect((await tx`select id from tickets where workspace_id in ${tx(ids)}`).length).toBe(4);
        expect((await tx`select id from audit_events where workspace_id in ${tx(ids)} and action='brand.archived'`).length).toBe(4);
        expect((await tx`select * from workspaces where id=${space.id}`)[0]).toEqual(space);
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
  });

  it('refuses to archive an active target', async () => {
    await expect(sql.begin(async tx => {
      await tx`select provision_brand('Oh My Casino','oh-my-casino-51515fe7')`;
      await tx.unsafe(migration);
    })).rejects.toThrow('Archive precondition failed');
  });
});
