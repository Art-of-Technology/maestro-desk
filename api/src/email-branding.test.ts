// Email branding — pure HTML/text helpers (always) + DB-backed CRUD,
// default-uniqueness, tenant isolation, and composition (RUN_DB_TESTS).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

// env.ts validates process.env at import; provide hermetic fallbacks so the
// pure block runs without a real api/.env. `||=` keeps real values when set.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const { textToHtml, escapeHtml } = await import('./lib/email-branding.js');

describe('email-branding text/HTML helpers', () => {
  it('escapes HTML-significant characters', () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  });

  it('escapes then linkifies bare URLs and keeps trailing punctuation out of the href', () => {
    const html = textToHtml('See https://acme.com/x?a=1&b=2.');
    expect(html).toContain('<a href="https://acme.com/x?a=1&amp;b=2"');
    // The trailing period is not part of the link.
    expect(html).toContain('</a>.');
  });

  it('injects no markup from user content beyond the anchors it adds', () => {
    const html = textToHtml('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('converts newlines to <br>', () => {
    expect(textToHtml('a\nb')).toBe('a<br>b');
  });
});

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('email branding (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let composeEmail: typeof import('./lib/email-branding.js').composeEmail;

  const RUN = Date.now();
  const admin = { email: `eb-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `eb-agent-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: email }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  function as(token: string, wsId: string, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Workspace-Id', wsId);
    headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    composeEmail = (await import('./lib/email-branding.js')).composeEmail;

    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;

    const [{ provision_brand: wsA }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'eb-a-' + RUN}, ${'eb-a-' + RUN}) as provision_brand`;
    const [{ provision_brand: wsB }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'eb-b-' + RUN}, ${'eb-b-' + RUN}) as provision_brand`;
    ctx.wsA = wsA; ctx.wsB = wsB;

    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsA} and is_admin = true limit 1`;
    const [roRole]    = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsA} and coalesce(is_admin,false) = false limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsA}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsA}, ${agent.userId}, ${roRole.id}, true)`;
    // Member of B too, so the isolation check exercises a real membership.
    const [adminRoleB] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsB} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsB}, ${admin.userId}, ${adminRoleB.id}, true)`;

    await sql`update workspaces set logo_url = 'https://cdn.test/logo.png' where id = ${wsA}`;
  }, 30000);

  afterAll(async () => {
    await sql`delete from email_signatures where workspace_id in (${ctx.wsA}, ${ctx.wsB})`;
    await sql`delete from email_brand_templates where workspace_id in (${ctx.wsA}, ${ctx.wsB})`;
  }, 15000);

  it('non-admin cannot create a template; admin can', async () => {
    const denied = await as(agent.token, ctx.wsA, '/api/v1/email-branding/templates', {
      method: 'POST', body: JSON.stringify({ name: 'Nope' }),
    });
    expect(denied.status).toBe(403);

    const ok = await as(admin.token, ctx.wsA, '/api/v1/email-branding/templates', {
      method: 'POST', body: JSON.stringify({ name: 'Brand A', footer_text: 'Acme Ltd', is_default: true }),
    });
    expect(ok.status).toBe(201);
    const { template } = await ok.json();
    expect(template.is_default).toBe(true);
  });

  it('keeps exactly one default template per workspace', async () => {
    // Add a second default — the first must flip off.
    const res = await as(admin.token, ctx.wsA, '/api/v1/email-branding/templates', {
      method: 'POST', body: JSON.stringify({ name: 'Brand A2', is_default: true }),
    });
    expect(res.status).toBe(201);
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from email_brand_templates
      where workspace_id = ${ctx.wsA} and is_default = true and deleted_at is null
    `;
    expect(count).toBe('1');
  });

  it('isolates templates by workspace', async () => {
    const res = await as(admin.token, ctx.wsB, '/api/v1/email-branding/templates');
    const { templates } = await res.json();
    expect(templates).toHaveLength(0);
  });

  it('an agent manages their own default signature (one default)', async () => {
    const s1 = await as(agent.token, ctx.wsA, '/api/v1/email-branding/signatures', {
      method: 'POST', body: JSON.stringify({ name: 'Std', body_text: 'Jane Doe\nSupport', is_default: true }),
    });
    expect(s1.status).toBe(201);
    const s2 = await as(agent.token, ctx.wsA, '/api/v1/email-branding/signatures', {
      method: 'POST', body: JSON.stringify({ name: 'Alt', body_text: 'J. Doe', is_default: true }),
    });
    expect(s2.status).toBe(201);
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from email_signatures
      where workspace_id = ${ctx.wsA} and user_id = ${agent.userId} and is_default = true and deleted_at is null
    `;
    expect(count).toBe('1');
  });

  it('composeEmail wraps the body with logo + footer, and the author signature', async () => {
    // Pin a known default deterministically (earlier tests may have changed it).
    await sql`update email_brand_templates set is_default = false where workspace_id = ${ctx.wsA}`;
    await sql`update email_brand_templates set is_default = true, footer_text = 'Acme Ltd', show_logo = true
              where workspace_id = ${ctx.wsA} and name = 'Brand A'`;
    const composed = await composeEmail({ workspaceId: ctx.wsA, authorUserId: agent.userId, bodyText: 'Hello body' });
    expect(composed.html).not.toBeNull();
    expect(composed.html!).toContain('https://cdn.test/logo.png');   // logo from workspace
    expect(composed.html!).toContain('Acme Ltd');                    // footer from default template
    expect(composed.html!).toContain('Hello body');                  // the message
    expect(composed.html!).toContain('J. Doe');                      // agent's default signature
    expect(composed.text).toContain('Hello body');
    expect(composed.text).toContain('Acme Ltd');
  });

  it('composeEmail returns plain text (no html) for a workspace with no template', async () => {
    const composed = await composeEmail({ workspaceId: ctx.wsB, bodyText: 'Plain only' });
    expect(composed.html).toBeNull();
    expect(composed.text).toBe('Plain only');
  });
});
