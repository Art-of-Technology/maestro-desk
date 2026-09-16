import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { genericDetails, rankReplies } from './lib/previous-replies.js';

it('requires meaningful overlap and ranks query/response pairs', () => {
  expect(rankReplies('hello please help', [{ subject: 'hello please help', question: '' }])).toEqual([]);
  const rows = [{ id: 1, subject: 'withdrawal delayed', question: 'bank transfer pending' },
    { id: 2, subject: 'bonus missing', question: 'spin reward missing' }];
  expect(rankReplies('bank transfer withdrawal delayed', rows).map(r => r.id)).toEqual([1]);
});
it('removes known customer details without replacing substrings in ordinary words', () => {
  const text = genericDetails('Hi Ann Lee. Annex: ann@example.com, TK-123, https://site.test/private/123, 123456789.',
    { first_name: 'Ann', last_name: 'Lee', email: 'ann@example.com' }, 'TK-123');
  expect(text).toContain('Hi {name}. Annex:');
  expect(text).not.toContain('ann@example.com');
  expect(text).not.toContain('@example.com');
  expect(text).not.toContain('TK-123');
  expect(text).not.toContain('https://');
  expect(text).not.toContain('123456789');
  expect(genericDetails('Hi Name {name}', { first_name: 'Name' }, 'TK-1')).toBe('Hi {name} {name}');
});

(process.env.RUN_DB_TESTS ? describe : describe.skip)('previous reply API', () => {
  let app: typeof import('./index.js').default;
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let ws: string, other: string, user: string, token: string, target: string, foreign: string;
  let createSpy: any;
  const fixtures: Record<string, string> = {};
  const run = crypto.randomUUID();
  const request = (action: string, ticketId = target, text = 'Hi Alice, your reference is 123456789.') => app.request('/api/v1/ai/messages', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ticketId, messages: [{ role: 'user', content: text }] }),
  });
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const signup = await auth.api.signUpEmail({ body: { email: `previous-${run}@t.test`, password: 'test-password-12345', name: 'Test Agent' } });
    user = signup.user.id; token = signup.token!;
    [ws, other] = await Promise.all(['a','b'].map(async key => (await sql`select provision_brand('Previous replies test', ${'previous-' + key + run}) as id`)[0].id));
    const [role] = await sql`select id from roles where workspace_id=${ws} and is_admin=true limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values (${ws},${user},${role.id},true)`;
    await sql`update workspaces set ai_credits_micro=10000000 where id=${ws}`;
    for (const key of ['target','match','brand','market','deleted','note','foreign','erased']) {
      const workspace = key === 'foreign' ? other : ws;
      const [customer] = await sql`insert into customers(workspace_id,display_id,first_name,last_name,brand,jurisdiction)
        values (${workspace},${'C-' + key},'Alice','Private',${key === 'brand' ? 'Other' : 'Test'},${key === 'market' ? 'MT' : 'GB'}) returning id`;
      const [ticket] = await sql`insert into tickets(workspace_id,display_id,subject,customer_id,status_key,priority_key)
        values (${workspace},${'TK-' + key},'bank transfer withdrawal delayed',${customer.id},${key === 'target' ? 'open' : 'resolved'},'normal') returning id`;
      fixtures[key] = ticket.id;
      await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,created_at) values
        (${workspace},${ticket.id},'customer','Alice','bank transfer withdrawal delayed',now()-interval '2 minutes'),
        (${workspace},${ticket.id},${key === 'note' ? 'note' : 'agent'},'Agent','Hi Alice Private. Check your bank transfer reference 123456789.',now()-interval '1 minute')`;
      if (key === 'deleted') await sql`update tickets set deleted_at=now() where id=${ticket.id}`;
      if (key === 'erased') await sql`update customers set erased_at=now() where id=${customer.id}`;
    }
    target = fixtures.target; foreign = fixtures.foreign;
    const { anthropic } = await import('./lib/anthropic.js');
    createSpy = spyOn(anthropic.messages, 'create');
    createSpy.mockImplementation(async () => ({
      id: 'previous-test', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'compose_customer_reply', input: {
        customerReply: 'Hi {name}, please check {transaction_reference}.', referenceIds: [], internalNotes: ['Check current policy.'],
      } }], usage: { input_tokens: 20, output_tokens: 20 },
    }) as any);
  });
  afterAll(async () => {
    createSpy?.mockRestore();
    if (sql && ws && other) await sql`delete from workspaces where id in (${ws},${other})`;
    if (sql && user) await sql`delete from users where id=${user}`;
  });
  it('rejects another workspace ticket and excludes other brands, markets, deleted records and notes', async () => {
    expect((await request('similar_reply', foreign)).status).toBe(404);
    const res = await request('similar_reply');
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.examples.map((e: any) => e.id)).toEqual(['TK-match']);
    expect(JSON.stringify(data.examples)).not.toContain('Alice');
    expect(JSON.stringify(data.examples)).not.toContain('123456789');
    expect(createSpy.mock.calls.at(-1)[0].system).toContain('ONLY published knowledge');
  });
  it('returns no-match feedback without spending on generation', async () => {
    await sql`update tickets set status_key='open' where id=${fixtures.match}`;
    const calls = createSpy.mock.calls.length;
    const data: any = await (await request('similar_reply')).json();
    expect(data.text).toBe(''); expect(data.examples).toEqual([]);
    expect(createSpy.mock.calls.length).toBe(calls);
  });
  it('generalizes templates and requires admin permission', async () => {
    expect((await request('generic_template')).status).toBe(200);
    const sent = createSpy.mock.calls.at(-1)[0].messages[0].content;
    expect(sent).not.toContain('Alice'); expect(sent).not.toContain('123456789');
    const [role] = await sql`select id from roles where workspace_id=${ws} and is_admin=false limit 1`;
    await sql`update workspace_members set role_id=${role.id} where workspace_id=${ws} and user_id=${user}`;
    expect((await request('generic_template')).status).toBe(403);
  });
  it('blocks unfinished template fields in text and encoded HTML before sending', async () => {
    for (const content of [{ body: 'Hello {name}' }, { body: 'Done', body_html: '<p>&#123;transaction_reference&#125;</p>' }]) {
      const res = await app.request(`/api/v1/tickets/${target}/messages`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'agent', ...content }) });
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toContain('placeholders');
    }
  });
});
