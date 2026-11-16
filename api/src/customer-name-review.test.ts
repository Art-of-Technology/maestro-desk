import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import { normalizeName } from './lib/customer-email-names.js';

test('name comparison normalizes casing, spacing and canonical Unicode', () => {
  expect(normalizeName('  JOSE\u0301   Smith ')).toBe('josé smith');
});

(process.env.RUN_DB_TESTS ? describe : describe.skip)('contact name review (database)', () => {
  let app: any, sql: any, workspace: string, otherWorkspace: string, user: string, token: string, role: string;
  const run = Date.now();
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const signed: any = await auth.api.signUpEmail({ body: { email: `name-review-${run}@test.example`, password: 'password-12345', name: 'Review Agent' }, returnHeaders: true });
    user = signed.response.user.id; token = signed.response.token;
    [{ provision_brand: workspace }] = await sql`select provision_brand('Name tests', ${'names-' + run})`;
    [{ provision_brand: otherWorkspace }] = await sql`select provision_brand('Other name tests', ${'other-names-' + run})`;
    const [r] = await sql`insert into roles(workspace_id, name, is_admin, permissions) values (${workspace}, 'Name reviewer', false,
      ${sql.json({ 'customers.view': true, 'customers.edit': true, 'tickets.view_all': true })}) returning id`;
    role = r.id;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${workspace},${user},${role},true)`;
  }, 30000);
  afterAll(async () => {
    for (const ws of [workspace, otherWorkspace].filter(Boolean)) {
      await sql`delete from ticket_messages where workspace_id=${ws}`;
      await sql`delete from tickets where workspace_id=${ws}`;
      await sql`delete from customer_notes where workspace_id=${ws}`;
      await sql`delete from gdpr_erasures where workspace_id=${ws}`;
      await sql`delete from customers where workspace_id=${ws}`;
    }
  });
  const request = (id: string, body: any, ws = workspace) => app.request(`/api/v1/customers/${id}/name-review`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const names = async (id: string) => (await import('./lib/customer-email-names.js')).customerEmailNames(sql, workspace, id);
  async function fixture(ws = workspace) {
    const email = `jane-${crypto.randomUUID()}@example.test`;
    const [c] = await sql`insert into customers(workspace_id, display_id, first_name, last_name, email, maestro_user_id)
      values(${ws},${'C-' + crypto.randomUUID()},'Jane','Doe',${email},${crypto.randomUUID()}) returning id`;
    const [t] = await sql`insert into tickets(workspace_id,display_id,customer_id,subject,status_key,priority_key)
      values(${ws},${'T-' + crypto.randomUUID()},${c.id},'Name fixture','open','normal') returning id`;
    const [m] = await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,email_metadata)
      values(${ws},${t.id},'customer','Janey','Hello',${sql.json({ status: 'received', from: email })}) returning id`;
    return { customer: c.id, ticket: t.id, message: m.id, email };
  }
  test('server names load, reviews persist with actor/reason and are idempotent', async () => {
    const f = await fixture();
    const summaryResponse = await app.request(`/api/v1/customers/${f.customer}/summary`, { headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspace } });
    expect(summaryResponse.status).toBe(200);
    const before = (await summaryResponse.json()).email_names;
    expect(before?.account_holder_name).toBe('Jane Doe');
    const entry = before!.entries[0];
    expect(entry.sender_name).toBe('Janey'); expect(entry.mismatch).toBe(true);
    const body = { review_key: entry.review_key, reason: 'Evidence of a formal name change checked' };
    const response = await request(f.customer, body);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.email_names.entries[0].reviewed.by).toBe('Review Agent');
    expect(data.email_names.entries[0].reviewed.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(data.email_names.entries[0].reviewed.reason).toContain(body.reason);
    await request(f.customer, body);
    const notes = await sql`select * from customer_notes where customer_id=${f.customer} and workspace_id=${workspace}`;
    expect(notes).toHaveLength(1); expect(notes[0].author_user_id).toBe(user);
    expect((await names(f.customer))!.entries[0].reviewed).not.toBeNull();
    await sql`update customers set first_name='Janet' where id=${f.customer}`;
    expect((await names(f.customer))!.entries[0].reviewed).toBeNull();
    expect((await request(f.customer, body)).status).toBe(409);
    const changed = (await names(f.customer))!.entries[0];
    await request(f.customer, { review_key: changed.review_key, reason: 'Updated account checked' });
    await sql`update ticket_messages set author_label='J. Doe' where id=${f.message}`;
    expect((await names(f.customer))!.entries[0].reviewed).toBeNull();
  });
  test('latest sender only; excludes third-party, forwarded and merged messages; handles unknown/matching names', async () => {
    const f = await fixture();
    for (const [sender, address, forwarded, merged] of [
      ['Outsider', 'other@example.test', false, false], ['Forwarded', f.email, true, false], ['Merged', f.email, false, true],
    ] as const) {
      await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,email_metadata,forwarded_from_ticket_ids,merged_from_id)
        values(${workspace},${f.ticket},'customer',${sender},'Hello',${sql.json({status:'received',from:address})},${forwarded ? [f.ticket] : []}::uuid[],${merged ? f.ticket : null})`;
    }
    expect((await names(f.customer))!.entries[0].sender_name).toBe('Janey');
    await sql`update ticket_messages set author_label='  JANE   DOE ' where id=${f.message}`;
    expect((await names(f.customer))!.entries[0].mismatch).toBe(false);
    await sql`update ticket_messages set author_label=${f.email} where id=${f.message}`;
    expect((await names(f.customer))!.entries[0].sender_name).toBeNull();
    await sql`update ticket_messages set author_label='Janey' where id=${f.message}`;
    await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,email_metadata,created_at)
      values(${workspace},${f.ticket},'customer','New Name','Hello',${sql.json({status:'received',from:f.email})},now()+interval '1 second')`;
    expect((await names(f.customer))!.entries[0].sender_name).toBe('New Name');
    await sql`update customers set maestro_user_id=null where id=${f.customer}`;
    expect((await names(f.customer))!.entries[0].mismatch).toBe(false);
  });
  test('rejects missing reasons, stale keys, foreign profiles, erased profiles and missing permission', async () => {
    const f = await fixture(), other = await fixture(otherWorkspace);
    const key = (await names(f.customer))!.entries[0].review_key;
    expect((await request(f.customer,{review_key:key,reason:' '})).status).toBe(400);
    expect((await request(f.customer,{review_key:'f'.repeat(64),reason:'Review'})).status).toBe(409);
    expect((await request(other.customer,{review_key:key,reason:'Review'})).status).toBe(404);
    await sql`update roles set permissions=${sql.json({'customers.view':true,'tickets.view_all':true})} where id=${role}`;
    expect((await request(f.customer,{review_key:key,reason:'Review'})).status).toBe(403);
    await sql`update roles set permissions=${sql.json({'customers.view':true,'customers.edit':true,'tickets.view_all':true})} where id=${role}`;
    await sql`update customers set erased_at=now() where id=${f.customer}`;
    expect(await names(f.customer)).toBeNull();
    expect((await request(f.customer,{review_key:key,reason:'Review'})).status).toBe(404);
  });
  test('review evidence follows existing export and erasure paths', async () => {
    const f = await fixture();
    const key = (await names(f.customer))!.entries[0].review_key;
    await request(f.customer,{review_key:key,reason:'Name change evidence checked'});
    const exported = await (await import('./lib/gdpr-export.js')).exportCustomer({ workspaceId: workspace, customerId: f.customer });
    expect(exported!.notes.some(n => n.text.includes('Name change evidence checked'))).toBe(true);
    await (await import('./lib/gdpr-erasure.js')).eraseCustomer({workspaceId:workspace,customerId:f.customer,requestedByUserId:user}, {deleteObjects:async()=>{}});
    expect(await sql`select id from customer_notes where workspace_id=${workspace} and customer_id=${f.customer}`).toHaveLength(0);
  });
});
