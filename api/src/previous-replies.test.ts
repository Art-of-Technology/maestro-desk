import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { genericDetails, rankReplies, previousReplyMaterial, searchReplyHistory } from './lib/previous-replies.js';
import { selectedReplies, expandedReplyTerms } from './lib/meaningful-replies.js';
import { SEARCH_CALL_CAP_MICRO } from './lib/reply-search-ai.js';

it('validates ranked IDs and permits an explicit no-match answer', () => {
  const example = { id: 'TK-1', title: 'Cashout', question: 'Pending', reply: 'Review', questionId: 'q', replyId: 'r' };
  expect(selectedReplies({ ids: [] }, [example])).toEqual([]);
  expect(selectedReplies({ ids: ['C1'] }, [example])).toEqual([example]);
  expect(selectedReplies({ ids: ['unknown'] }, [example])).toBeNull();
  expect(selectedReplies({ ids: ['C1','C1'] }, [example])).toBeNull();
  expect(selectedReplies({ ids: ['C1'], extra: 'untrusted' }, [example])).toBeNull();
});

it('keeps translated search words when earlier phrases contain many English synonyms', () => {
  const terms = expandedReplyTerms('My welcome free spins never appeared after I played through my first deposit',
    ['welcome free spins promotion credit missing first deposit account not received',
      'bonus reward offer initial registration credit failed absent missing', 'bono bienvenida giros gratis']);
  expect(terms.split(' ')).toContain('bono');
  expect(terms.split(' ')).toContain('bienvenida');
  expect(terms.split(' ').length).toBeLessThanOrEqual(30);
});

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
  let searchMode = 'normal';
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
    for (const key of ['target','match','brand','market','deleted','note','foreign','erased','old']) {
      const workspace = key === 'foreign' ? other : ws;
      const [customer] = await sql`insert into customers(workspace_id,display_id,first_name,last_name,brand,jurisdiction)
        values (${workspace},${'C-' + key},'Alice','Private',${key === 'brand' ? 'Other' : 'Test'},${key === 'market' ? 'MT' : 'GB'}) returning id`;
      const [ticket] = await sql`insert into tickets(workspace_id,display_id,subject,customer_id,status_key,priority_key)
        values (${workspace},${'TK-' + key},${key === 'old' ? 'cashout queued' : 'bank transfer withdrawal delayed'},${customer.id},${key === 'target' ? 'open' : 'resolved'},'normal') returning id`;
      fixtures[key] = ticket.id;
      await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,created_at) values
        (${workspace},${ticket.id},'customer','Alice',${key === 'old' ? 'payout pending' : 'bank transfer withdrawal delayed'},now()-interval '2 years'),
        (${workspace},${ticket.id},${key === 'note' ? 'note' : 'agent'},'Agent','Hi Alice Private. Check your bank transfer reference 123456789.',now()-interval '1 minute')`;
      if (key === 'deleted') await sql`update tickets set deleted_at=now() where id=${ticket.id}`;
      if (key === 'erased') await sql`update customers set erased_at=now() where id=${customer.id}`;
    }
    // A relevant question is older than 200 newer, unrelated tickets.
    await sql`insert into tickets(workspace_id,display_id,subject,customer_id,status_key,priority_key)
      select ${ws},'TK-noise-' || n,'bonus reward promotion',customer_id,'resolved','normal'
      from tickets cross join generate_series(1,5000) n where id=${fixtures.target}`;
    await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body)
      select ${ws},id,'customer','Alice','bonus reward promotion' from tickets
      where workspace_id=${ws} and display_id like 'TK-noise-%'`;
    await sql`analyze tickets`;
    await sql`analyze ticket_messages`;
    target = fixtures.target; foreign = fixtures.foreign;
    const { anthropic } = await import('./lib/anthropic.js');
    createSpy = spyOn(anthropic.messages, 'create');
  });
  beforeEach(async () => {
    searchMode = 'normal';
    await sql`update tickets set status_key='resolved' where id=${fixtures.match}`;
    await sql`update tickets set subject='bank transfer withdrawal delayed' where id=${fixtures.target}`;
    await sql`update ticket_messages set body='bank transfer withdrawal delayed' where ticket_id=${fixtures.target} and role='customer'`;
    await sql`update customers set erased_at=null where id=(select customer_id from tickets where id=${fixtures.match})`;
    await sql`update workspaces set ai_credits_micro=10000000 where id=${ws}`;
    await sql`delete from ai_usage_log where workspace_id=${ws}`;
    await sql`delete from rate_limit_hits where bucket=${'ai-assistant:' + ws + ':' + user}`;
    createSpy.mockReset();
    createSpy.mockImplementation(async (args: any, options: any) => {
      const tool = args.tool_choice.name;
      let input: unknown;
      if (tool === 'expand_reply_search') {
        expect(options.timeout).toBe(8000); expect(options.maxRetries).toBe(0);
        if (searchMode === 'failure') throw new Error('Provider timeout');
        input = { phrases: [searchMode === 'paraphrase' ? 'cashout queued payout pending' : 'bank transfer withdrawal delayed'] };
      } else if (tool === 'rank_reply_search') {
        const candidates = JSON.parse(args.messages[0].content).candidates;
        if (searchMode === 'rank-failure') throw new Error('Provider timeout');
        if (searchMode === 'erasure') await sql`update customers set erased_at=now() where id=(select customer_id from tickets where id=${fixtures.match})`;
        const picked = candidates.find((r: any) => r.title === (searchMode === 'paraphrase' ? 'cashout queued' : 'bank transfer withdrawal delayed'));
        input = { ids: searchMode === 'irrelevant' ? [] : searchMode === 'invalid' ? ['invented-id'] : picked ? [picked.id] : [] };
      } else input = { customerReply: 'Hi {name}, please check {transaction_reference}.', referenceIds: [], internalNotes: ['Check current policy.'] };
      return { id: 'previous-test', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: tool, input }], usage: { input_tokens: 20, output_tokens: 20 } };
    });
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
  it('returns no-match feedback without spending on reply generation', async () => {
    await sql`update tickets set status_key='open' where id=${fixtures.match}`;
    const calls = createSpy.mock.calls.length;
    const data: any = await (await request('similar_reply')).json();
    expect(data.text).toBe(''); expect(data.examples).toEqual([]);
    expect(createSpy.mock.calls.length).toBe(calls + 1);
    expect(createSpy.mock.calls.at(-1)[0].tool_choice.name).toBe('expand_reply_search');
  });
  it('retrieves differently worded history beyond 200 newer tickets and records all paid steps', async () => {
    searchMode = 'paraphrase';
    await sql`update tickets set subject='Funds absent' where id=${target}`;
    await sql`update ticket_messages set body='My money still not here' where ticket_id=${target} and role='customer'`;
    const data: any = await (await request('similar_reply')).json();
    expect(data.examples.map((e: any) => e.id)).toEqual(['TK-old']);
    expect(createSpy.mock.calls.length).toBe(3);
    const usage = await sql`select action,cost_usd_micro from ai_usage_log where workspace_id=${ws}`;
    expect(usage.map(r => r.action).sort()).toEqual(['reply_search_expand','reply_search_rank','similar_reply']);
    expect(data.cost_micro).toBe(usage.reduce((n, r) => n + Number(r.cost_usd_micro), 0));
    expect(data.balance_micro).toBe(10000000 - data.cost_micro);
    expect(usage.filter(r => r.action !== 'similar_reply').every(r => Number(r.cost_usd_micro) <= SEARCH_CALL_CAP_MICRO)).toBe(true);
    expect(JSON.stringify(data.examples)).not.toContain('questionId');
  });
  it('supports translated query expansion', async () => {
    searchMode = 'paraphrase';
    await sql`update tickets set subject='Mi dinero no llega' where id=${target}`;
    await sql`update ticket_messages set body='Todavía no lo recibí' where ticket_id=${target} and role='customer'`;
    const data: any = await (await request('similar_reply')).json();
    expect(data.examples.map((e: any) => e.id)).toEqual(['TK-old']);
  });
  it('uses the history indexes and bounds lookup time with 5,000 newer questions', async () => {
    const context = await previousReplyMaterial(ws, target, false);
    const start = performance.now();
    const matches = await searchReplyHistory(ws, context!.ticket, 'cashout queued payout pending');
    const elapsed = performance.now() - start;
    expect(matches.map(m => m.id)).toContain('TK-old');
    expect(elapsed).toBeLessThan(4000);
    console.log(`Indexed history lookup across 5,000 newer questions: ${Math.round(elapsed)} ms`);
    const plan = await sql`explain (format json) select id from ticket_messages
      where workspace_id=${ws} and role='customer' and deleted_at is null and merged_from_id is null
        and to_tsvector('simple',left(body,8000)) @@ to_tsquery('simple','payout | pending')`;
    expect(JSON.stringify(plan)).toContain('reply_customer_text_search');
    const subjectPlan = await sql`explain (format json) select id from tickets
      where workspace_id=${ws} and deleted_at is null and merged_into_id is null and status_key in ('resolved','closed')
        and to_tsvector('simple',left(subject,1000)) @@ to_tsquery('simple','cashout | queued')`;
    expect(JSON.stringify(subjectPlan)).toContain('reply_ticket_subject_search');
  });
  it('falls back on provider failures and invalid ranking IDs, refunding failed calls', async () => {
    for (const mode of ['failure','rank-failure','invalid']) {
      searchMode = mode;
      await sql`delete from ai_usage_log where workspace_id=${ws}`;
      const [before] = await sql`select ai_credits_micro from workspaces where id=${ws}`;
      const data: any = await (await request('similar_reply')).json();
      expect(data.examples[0].id).toBe('TK-match');
      expect(data.internal.notes.join(' ')).toContain('keyword matching');
      const [usage] = await sql`select sum(cost_usd_micro)::int as cost from ai_usage_log where workspace_id=${ws}`;
      expect(data.cost_micro).toBe(usage.cost);
      expect(data.balance_micro).toBe(Number(before.ai_credits_micro) - usage.cost);
    }
  });
  it('rejects irrelevant matches and excludes a record erased during ranking', async () => {
    for (const mode of ['irrelevant', 'erasure']) {
      searchMode = mode;
      const data: any = await (await request('similar_reply')).json();
      expect(data.examples).toEqual([]); expect(data.text).toBe('');
      expect(createSpy.mock.calls.every((call: any[]) => call[0].tool_choice.name !== 'compose_customer_reply')).toBe(true);
    }
  });
  it('does not call the provider when credit is exhausted', async () => {
    await sql`update workspaces set ai_credits_micro=0 where id=${ws}`;
    expect((await request('similar_reply')).status).toBe(402);
    expect(createSpy).not.toHaveBeenCalled();
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
