import { beforeAll, afterAll, describe, test, expect } from 'bun:test';

(process.env.RUN_DB_TESTS ? describe : describe.skip)('settings spam contacts', () => {
  let app: any, sql: any, workspace: string, other: string, user: string, token: string, role: string, customer: string;
  const run = crypto.randomUUID();
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const signed = await (await import('./lib/auth.js')).auth.api.signUpEmail({ body: {
      email: `spam-list-${run}@test.example`, password: 'password-12345', name: 'Spam Reviewer',
    } });
    user = signed.user.id; token = signed.token!;
    [{ provision_brand: workspace }] = await sql`select provision_brand('Spam list tests', ${'spam-list-' + run})`;
    [{ provision_brand: other }] = await sql`select provision_brand('Other spam tests', ${'spam-other-' + run})`;
    const [r] = await sql`insert into roles(workspace_id,name,permissions) values(${workspace},'Reviewer',
      ${sql.json({ 'customers.view': true, 'customers.spam': true })}) returning id`;
    role = r.id;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${workspace},${user},${role},true)`;
    const [c] = await sql`insert into customers(workspace_id,display_id,first_name,last_name,email)
      values(${workspace},'SPAM-TEST','Alex','Example',${'spam-' + run + '@example.test'}) returning id`;
    customer = c.id;
    await sql`insert into customer_contacts(workspace_id,customer_id,kind,value,is_primary)
      values(${workspace},${customer},'email',${'secondary-' + run + '@example.test'},false)`;
  }, 30000);
  afterAll(async () => {
    if (workspace) await sql`delete from workspaces where id=${workspace}`;
    if (other) await sql`delete from workspaces where id=${other}`;
    if (user) await sql`delete from users where id=${user}`;
  });
  const request = (path: string, method = 'GET') => app.request('/api/v1/customers' + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspace },
  });

  test('lists persisted spam, searches secondary addresses and preserves unmark history', async () => {
    expect((await request(`/${customer}/spam`, 'POST')).status).toBe(200);
    const list = await (await request('/spam?q=Alex')).json();
    expect(list.contacts).toHaveLength(1);
    expect(list.contacts[0]).toMatchObject({ id: customer, marked_by: 'Spam Reviewer' });
    expect(list.contacts[0].marked_at).toBeTruthy();
    expect((await (await request('/spam?q=secondary-' + run)).json()).contacts).toHaveLength(1);
    expect((await (await request('/spam?q=%25')).json()).contacts).toHaveLength(0);
    expect((await request(`/${customer}/spam`, 'DELETE')).status).toBe(200);
    expect((await (await request('/spam')).json()).contacts).toHaveLength(0);
    const history = await (await request(`/${customer}/spam-history`)).json();
    expect(history.events.map((e: any) => e.action)).toEqual(['customer.spam_unmarked', 'customer.spam_marked']);
    expect(history.events.every((e: any) => e.actor === 'Spam Reviewer')).toBe(true);
    expect(history.events[0].metadata).toBeUndefined();
  });

  test('paginates, excludes unavailable contacts and does not invent attribution', async () => {
    await sql`insert into customers(workspace_id,display_id,first_name,is_spam)
      select ${workspace}, 'PAGE-' || n, 'Listed', true from generate_series(1,51) n`;
    await sql`insert into customers(workspace_id,display_id,first_name,is_spam,deleted_at)
      values(${workspace},'DELETED','Deleted',true,now())`;
    await sql`insert into customers(workspace_id,display_id,first_name,is_spam,erased_at)
      values(${workspace},'ERASED','Erased',true,now())`;
    await sql`insert into customers(workspace_id,display_id,first_name,is_spam,merged_into_customer_id)
      values(${workspace},'MERGED','Merged',true,${customer})`;
    const [foreign] = await sql`insert into customers(workspace_id,display_id,first_name,is_spam)
      values(${other},'FOREIGN','Foreign',true) returning id`;
    const first = await (await request('/spam')).json(), second = await (await request('/spam?offset=50')).json();
    expect(first.contacts).toHaveLength(50); expect(first.next_offset).toBe(50);
    expect(second.contacts).toHaveLength(1); expect(second.next_offset).toBeNull();
    expect(new Set([...first.contacts, ...second.contacts].map((c: any) => c.id)).size).toBe(51);
    expect(first.contacts.every((c: any) => c.marked_at === null && c.marked_by === null)).toBe(true);
    expect((await request(`/${foreign.id}/spam-history`)).status).toBe(404);
    expect((await request(`/${foreign.id}/spam`, 'DELETE')).status).toBe(404);
    expect((await request('/spam?offset=-1')).status).toBe(400);
    expect((await request('/spam?q=' + 'a'.repeat(201))).status).toBe(400);
    expect((await request(`/${customer}/spam-history?offset=wrong`)).status).toBe(400);
    expect((await request('/bad-id/spam-history')).status).toBe(404);
    // History remains paginated and contains only the two spam actions.
    await sql`insert into audit_events(workspace_id,actor_user_id,action,target_type,target_id,metadata)
      select ${workspace},${user},'customer.spam_marked','customer',${customer},'{}'::jsonb from generate_series(1,51)`;
    const h = await (await request(`/${customer}/spam-history`)).json();
    expect(h.events).toHaveLength(50); expect(h.next_offset).toBe(50);
    expect((await (await request(`/${customer}/spam-history?offset=50`)).json()).events).toHaveLength(3);
  });

  test('requires viewing and spam permissions for reads and unmarking', async () => {
    for (const permissions of [{ 'customers.view': true }, { 'customers.spam': true }]) {
      await sql`update roles set permissions=${sql.json(permissions)} where id=${role}`;
      for (const path of ['/spam', `/${customer}/spam-history`]) expect((await request(path)).status).toBe(403);
      expect((await request(`/${customer}/spam`, 'DELETE')).status).toBe(403);
    }
  });
});
