import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { unzipSync } from 'fflate';
import PostalMime from 'postal-mime';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

(process.env.RUN_DB_TESTS ? describe : describe.skip)('ticket email download API', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: Hono;
  let ws: string, foreignWs: string, customer: string, ticket: string, foreignTicket: string, token: string;
  const run = crypto.randomUUID();
  async function addTicket(workspace = ws, owner = customer) {
    const [t] = await sql`insert into tickets (workspace_id,customer_id,display_id,subject,status_key,priority_key)
      values (${workspace},${owner},${crypto.randomUUID()},'Export test','open','normal') returning id`;
    return t.id as string;
  }
  async function message(role: string, body: string, status: string | null, ticketId = ticket) {
    const [m] = await sql`insert into ticket_messages (workspace_id,ticket_id,role,author_label,body,email_metadata,external_message_id)
      values (${ws},${ticketId},${role},'Fixture',${body},${status ? sql.json({status,from:'a@example.test',to:['b@example.test']}) : null},
        ${status === 'sent' || status === 'received' ? `<${crypto.randomUUID()}@test>` : null}) returning id`;
    return m.id as string;
  }
  function request(id = ticket, query = 'format=eml', workspace = ws, bearer = token) {
    return app.request(`/${id}/emails/download?${query}`, { headers: { Authorization: `Bearer ${bearer}`, 'X-Workspace-Id': workspace } });
  }
  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const signed: any = await auth.api.signUpEmail({ body: { email: `email-export-${run}@example.test`, name: 'Export tester', password: 'test-password-12345' } });
    token = signed.token;
    const [{ id }] = await sql`select provision_brand('Export tests', ${`export-${run}`}) as id`;
    ws = id;
    const [{ id: other }] = await sql`select provision_brand('Other tests', ${`export-other-${run}`}) as id`;
    foreignWs = other;
    const [role] = await sql`select id from roles where workspace_id=${ws} and is_admin=true limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values (${ws},${signed.user.id},${role.id},true)`;
    const [c] = await sql`insert into customers(workspace_id,display_id,first_name) values (${ws},'EXPORT','Fixture') returning id`;
    customer = c.id;
    const [fc] = await sql`insert into customers(workspace_id,display_id,first_name) values (${foreignWs},'FOREIGN','Other') returning id`;
    foreignTicket = await addTicket(foreignWs, fc.id);
    const { requireAuth } = await import('./middleware/auth.js');
    app = new Hono().use('*', requireAuth).route('/', (await import('./routes/ticket-email-downloads.js')).ticketEmailDownloads);
  }, 30000);
  beforeEach(async () => {
    await sql`delete from rate_limit_hits where bucket like ${`ticket-email-download:${ws}:%`}`;
    ticket = await addTicket();
  });
  it('exports only delivered emails and denies direct requests for internal/unsent/deleted messages', async () => {
    await message('customer', 'PUBLIC received', 'received');
    await message('agent', 'PUBLIC sent', 'sent');
    const ids = [await message('note', 'SECRET note', null), await message('system', 'SECRET status', null),
      await message('agent', 'SECRET saved', 'saved'), await message('ai', 'SECRET draft', null)];
    const deleted = await message('customer', 'SECRET deleted', 'received');
    await sql`update ticket_messages set deleted_at=now() where id=${deleted}`;
    ids.push(deleted);
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const zipped = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(zipped)).toHaveLength(2);
    for (const bytes of Object.values(zipped)) {
      const parsed = await PostalMime.parse(bytes);
      expect(parsed.text).toContain('PUBLIC');
      expect(parsed.text).not.toContain('SECRET');
    }
    for (const id of ids) expect((await request(ticket, `format=eml&messageId=${id}`)).status).toBe(404);
  });
  it('validates formats and enforces session, workspace, ticket and message ownership', async () => {
    expect((await request(ticket, 'format=html')).status).toBe(400);
    expect((await request(ticket, 'format=pdf&remoteImages=yes')).status).toBe(400);
    expect((await request(ticket, 'format=pdf', ws, 'invalid')).status).toBe(401);
    expect((await request(foreignTicket)).status).toBe(404);
    expect((await request(foreignTicket, 'format=pdf', foreignWs)).status).toBe(403);
    const other = await addTicket();
    const id = await message('customer', 'Other ticket', 'received', other);
    expect((await request(ticket, `format=eml&messageId=${id}`)).status).toBe(404);
  });
  it('exports the sent snapshot and clears it on redaction, rejecting late content after erasure', async () => {
    const id = await message('agent', 'Working reply', 'sent');
    const sent = { subject: 'Sent subject', text: 'Header Answer Footer', html: '<p>Header Answer Footer</p>', logo_url: null };
    await sql`update ticket_messages set sent_email=${sql.json(sent)} where id=${id}`;
    const res = await request(ticket, `format=eml&messageId=${id}`);
    expect(res.status).toBe(200);
    expect((await PostalMime.parse(await res.arrayBuffer())).text?.trim()).toBe(sent.text);
    await sql`update ticket_messages set body='[erased]' where id=${id}`;
    expect((await sql`select sent_email from ticket_messages where id=${id}`)[0].sent_email).toBeNull();
    await sql`update customers set erased_at=now() where id=${customer}`;
    try {
      let rejected = false;
      try { await sql`update ticket_messages set body='Reintroduced', sent_email=${sql.json(sent)} where id=${id}`; }
      catch { rejected = true; }
      expect(rejected).toBe(true);
      expect((await request()).status).toBe(404);
    } finally { await sql`update customers set erased_at=null where id=${customer}`; }
  });
  it('rejects deleted tickets, erased customers and empty threads', async () => {
    expect((await request()).status).toBe(404);
    await message('customer', 'Saved email', 'received');
    await sql`update tickets set deleted_at=now() where id=${ticket}`;
    expect((await request()).status).toBe(404);
    await sql`update tickets set deleted_at=null where id=${ticket}`;
    await sql`update customers set erased_at=now() where id=${customer}`;
    try { expect((await request()).status).toBe(404); }
    finally { await sql`update customers set erased_at=null where id=${customer}`; }
  });
  it('exports original merged messages once and resolves individual copies without inventing attachment links', async () => {
    const source = await addTicket();
    const original = await message('customer', 'Merged email', 'received', source);
    const [copy] = await sql`insert into ticket_messages (workspace_id,ticket_id,role,author_label,body,email_metadata,merged_from_id)
      select workspace_id,${ticket},role,author_label,body,email_metadata,${source} from ticket_messages where id=${original} returning id`;
    await sql`update tickets set merged_into_id=${ticket} where id=${source}`;
    const res = await request();
    expect(res.status).toBe(200);
    const zipped = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(zipped)).toHaveLength(1);
    expect(Object.keys(zipped)[0]).toContain(original);
    const single = await request(ticket, `format=eml&messageId=${copy.id}`);
    expect(single.status).toBe(200);
    expect((await PostalMime.parse(await single.arrayBuffer())).text?.trim()).toBe('Merged email');
    await sql`update tickets set deleted_at=now() where id=${source}`;
    expect((await request()).status).toBe(409);
  });
  it('refuses a partial EML when an attachment is unavailable, while PDF remains available', async () => {
    const id = await message('customer', 'Email with a file', 'received');
    await sql`insert into ticket_attachments(workspace_id,ticket_id,message_id,filename,storage_key,size_bytes)
      values (${ws},${ticket},${id},'receipt.txt','test-only-missing-object',7)`;
    expect((await request(ticket, `format=eml&messageId=${id}`)).status).toBe(503);
    const pdf = await request(ticket, `format=pdf&messageId=${id}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
  });
  it('rejects ambiguous old merged copies and still downloads both originals in the thread', async () => {
    const source = await addTicket();
    const original = await message('customer', 'Same content', 'received', source);
    await message('customer', 'Same content', 'received', source);
    const [copy] = await sql`insert into ticket_messages (workspace_id,ticket_id,role,author_label,body,email_metadata,merged_from_id)
      select workspace_id,${ticket},role,author_label,body,email_metadata,${source} from ticket_messages where id=${original} returning id`;
    await sql`update tickets set merged_into_id=${ticket} where id=${source}`;
    expect((await request(ticket, `format=eml&messageId=${copy.id}`)).status).toBe(409);
    const full = await request();
    expect(full.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(await full.arrayBuffer())))).toHaveLength(2);
  });
  it('rate limits repeated downloads per authenticated workspace member', async () => {
    for (let i = 0; i < 10; i++) expect((await request()).status).toBe(404);
    expect((await request()).status).toBe(429);
  });
});
