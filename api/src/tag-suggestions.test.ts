import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

const run = process.env.RUN_DB_TESTS ? describe : describe.skip;
run('tag-only triage', () => {
  let app: typeof import('./index.js').default;
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let ws: string, other: string, user: string, token: string, ticket: string, create: any, post: any;
  const request = (id = ticket, workspace = ws) => app.request(`/api/v1/tickets/${id}/triage/tags`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspace },
  });
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const signed = await auth.api.signUpEmail({ body: { email: `tags-${crypto.randomUUID()}@t.test`, password: 'password-12345', name: 'Tag Test' } });
    user = signed.user.id; token = signed.token!;
    [ws, other] = await Promise.all(['one', 'two'].map(async name => {
      const [w] = await sql`select provision_brand(${'tags-' + name + crypto.randomUUID()}, ${name}) as id`;
      const [role] = await sql`select id from roles where workspace_id=${w.id} and is_admin limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id) values (${w.id},${user},${role.id})`;
      return w.id;
    }));
    const [customer] = await sql`insert into customers(workspace_id,display_id,first_name)
      values (${ws},'M1','Test') returning id`;
    const [t] = await sql`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key,category_key,ai_summary,ai_draft_reply)
      values (${ws},${customer.id},'TK-23','Withdrawal question','open','normal','General','{"text":"keep summary"}','{"text":"keep draft"}') returning id`;
    ticket = t.id;
    const { anthropic } = await import('./lib/anthropic.js');
    create = spyOn(anthropic.messages, 'create');
    post = spyOn(await import('./lib/auto-reply.js'), 'postAutoReply').mockResolvedValue({ posted: false, reason: 'send_failed' });
  }, 30000);
  beforeEach(async () => {
    await sql`update workspaces set ai_credits_micro=10000000, auto_reply_min_confidence=1,
      auto_reply_categories=array['General'] where id in (${ws},${other})`;
    post.mockClear();
    await sql`delete from ticket_ai_tags where ticket_id=${ticket}`;
    await sql`delete from ticket_tags where ticket_id=${ticket}`;
    await sql`delete from rate_limit_hits where bucket=${'tag-suggestions:' + ws + ':' + user}`;
    await sql`insert into ticket_ai_tags(workspace_id,ticket_id,tag,confidence,accepted)
      values (${ws},${ticket},'accepted',80,true),(${ws},${ticket},'old',60,false)`;
    await sql`insert into ticket_tags(workspace_id,ticket_id,tag)
      values (${ws},${ticket},'accepted'),(${ws},${ticket},'manual')`;
    create.mockReset();
    create.mockResolvedValue({ id: 'tag-test', usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: 'tool_use', name: 'record_triage', input: {
        category_key: 'General', priority_key: 'urgent', sentiment: 'neutral', confidence: 99,
        summary: 'Do not persist', draft_reply: 'Do not send or persist',
        tags: ['accepted', 'manual', 'withdrawal', 'withdrawal'].map(tag => ({ tag, confidence: 95 })),
      } }] });
  });
  afterAll(async () => {
    create?.mockRestore();
    post?.mockRestore();
    if (!sql) return;
    for (const id of [ws, other].filter(Boolean)) await sql`delete from workspaces where id=${id}`;
    if (user) await sql`delete from users where id=${user}`;
  });
  it('saves only tags, preserves accepted/manual tags, and never posts an eligible auto-reply', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    const data: any = await response.json();
    expect(data.ai_tags.map((t: any) => t.tag).sort()).toEqual(['accepted', 'withdrawal']);
    expect(data.ai_tags.find((t: any) => t.tag === 'accepted').accepted).toBe(true);
    const [t] = await sql`select ai_summary,ai_draft_reply,priority_key from tickets where id=${ticket}`;
    expect(t).toMatchObject({ ai_summary: { text: 'keep summary' }, ai_draft_reply: { text: 'keep draft' }, priority_key: 'normal' });
    expect(await sql`select id from ticket_messages where ticket_id=${ticket}`).toHaveLength(0);
    expect(await sql`select tag from ticket_tags where ticket_id=${ticket}`).toHaveLength(2);
    expect((await request()).status).toBe(200);
    expect(await sql`select tag from ticket_ai_tags where ticket_id=${ticket}`).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
  });
  it('leaves tags intact on provider failure and succeeds on retry', async () => {
    create.mockRejectedValueOnce(new Error('Provider unavailable'));
    expect((await request()).status).toBe(500);
    expect((await sql`select tag from ticket_ai_tags where ticket_id=${ticket}`).map(t => t.tag).sort()).toEqual(['accepted','old']);
    expect((await request()).status).toBe(200);
  });
  it('rejects empty credit, foreign tickets and malformed identifiers before the AI call', async () => {
    expect((await request(ticket, other)).status).toBe(404);
    expect((await request('bad-id')).status).toBe(400);
    await sql`update workspaces set ai_credits_micro=0 where id=${ws}`;
    expect((await request()).status).toBe(402);
    expect(create).not.toHaveBeenCalled();
  });
  it('keeps full triage behavior for existing callers', async () => {
    const { triageTicket } = await import('./lib/triage.js');
    const result = await triageTicket({ ticketId: ticket, workspaceId: ws, userId: user });
    expect(result.auto_reply.decision.eligible).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    const [t] = await sql`select ai_summary,ai_draft_reply from tickets where id=${ticket}`;
    expect(t.ai_summary.text).toBe('Do not persist');
    expect(t.ai_draft_reply.text).toBe('Do not send or persist');
  });
});
