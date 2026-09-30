import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
const dbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
dbTests('brand AI credit notifications', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: typeof import('./index.js').default;
  let ws: string, other: string, user: string, token: string, admin: string, member: string;
  const request = (body?: unknown, workspace = ws) => app.request('/api/v1/ai/credit-alert', {
    method: body ? 'POST' : 'GET', headers:{Authorization:`Bearer ${token}`, 'X-Workspace-Id':workspace, 'Content-Type':'application/json'},
    ...(body ? {body:JSON.stringify(body)} : {}),
  });
  const alert = async () => (await (await request()).json() as {alert: {since:string;balance_micro:number;read:boolean;dismissed:boolean}}).alert;
  beforeAll(async () => {
    app = (await import('./index.js')).default; sql = (await import('./lib/db.js')).getDb();
    const run = crypto.randomUUID();
    const signup = await (await import('./lib/auth.js')).auth.api.signUpEmail({body:{email:`credit-${run}@test.invalid`,password:'test-password-12345',name:'Credit admin'}});
    user=signup.user.id; token=signup.token!;
    [ws,other] = await Promise.all(['a','b'].map(async suffix => (await sql`select provision_brand('Credit test', ${'credit-'+suffix+run}) as id`)[0].id));
    admin=(await sql`select id from roles where workspace_id=${ws} and is_admin limit 1`)[0].id;
    member=(await sql`select id from roles where workspace_id=${ws} and not is_admin limit 1`)[0].id;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${ws},${user},${admin},true)`;
  });
  afterAll(async()=>{if(sql){for(const id of [ws,other]) if(id) await sql`delete from workspaces where id=${id}`;if(user) await sql`delete from users where id=${user}`;}});
  it('uses actual spending, persists acknowledgement, and starts a new period after top-up',async()=>{
    await sql`update workspaces set ai_credits_micro=2100000 where id=${ws}`;
    expect(await alert()).toBeNull();
    await sql`update workspaces set ai_credits_micro=ai_credits_micro-200000, ai_reserved_micro=ai_reserved_micro+200000 where id=${ws}`;
    expect(await alert()).toBeNull();
    await sql`update workspaces set ai_credits_micro=ai_credits_micro+200000, ai_reserved_micro=ai_reserved_micro-200000 where id=${ws}`;
    expect(await alert()).toBeNull();
    await sql`select deduct_ai_credits(${ws},200001)`;
    const low=await alert(); expect(low.balance_micro).toBe(1899999); expect(low.read).toBe(false);
    expect((await request({since:low.since,dismissed:true})).status).toBe(200);
    expect((await alert()).dismissed).toBe(true);
    await sql`select deduct_ai_credits(${ws},1)`;
    expect((await alert()).since).toBe(low.since);
    await sql`update workspaces set ai_credits_micro=10000000 where id=${ws}`;
    expect(await alert()).toBeNull();
    await sql`update workspaces set ai_credits_micro=1999999 where id=${ws}`;
    const next=await alert();expect(next.since).not.toBe(low.since);expect(next.read).toBe(false);
    await request({since:low.since,dismissed:true});expect((await alert()).dismissed).toBe(false);
    await sql`update workspaces set ai_credits_micro=2000000 where id=${ws}`; expect(await alert()).toBeNull();
    await sql`update workspaces set ai_credits_micro=0 where id=${ws}`; expect((await alert()).balance_micro).toBe(0);
  });
  it('rejects other brands, non-admins and inactive memberships',async()=>{
    expect((await request(undefined,other)).status).toBe(403);
    await sql`update workspace_members set role_id=${member} where workspace_id=${ws} and user_id=${user}`;
    expect((await request()).status).toBe(403);
    expect((await request({since:new Date().toISOString()})).status).toBe(403);
    await sql`update workspace_members set role_id=${admin},active=false where workspace_id=${ws} and user_id=${user}`;
    expect((await request()).status).toBe(403);
  });
});
