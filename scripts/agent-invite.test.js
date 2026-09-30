import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'bun:test';

const source = readFileSync(new URL('../web/js/agents/index.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('function sendAgentPasswordReset('), source.indexOf('registerActions({'));

test('resend confirms the correct agent, sends once, and reports failures without changing membership', async () => {
  for (const result of ['success', 'rejected', 'offline', 'active', 'non-admin', 'switched']) {
    let confirm, calls = 0, title, body, workspace = 'one';
    const messages = [];
    const agents = [{ userId:'first', name:'Same name', email:'first@example.test', invited:true },
      { userId:'second', name:'Same name', email:'second@example.test', invited:result !== 'active', role:'Agent', active:false }];
    const before = JSON.stringify(agents);
    const context = {
      AGENTS:agents, window:{isAdmin:()=>result !== 'non-admin', escHtml:s=>s},
      getWorkspaceId:()=>workspace, getJwt:()=> 'session',
      showModal:(t,b,fn)=>{ title=t; body=b; confirm=fn; }, closeModal() {}, alert:s=>messages.push(s),
      apiPost:async (path, payload)=>{
        calls++; expect(path).toBe('/api/v1/agents/second/reset-password'); expect(payload).toEqual({});
        if (result === 'offline') throw new Error('Offline');
        return {email_sent:result !== 'rejected'};
      },
    };
    runInNewContext(handler + "sendAgentPasswordReset('second');", context);
    expect(calls).toBe(0);
    if (result === 'non-admin') { expect(confirm).toBeUndefined(); continue; }
    expect(title).toBe(result === 'active' ? 'Send password reset' : 'Resend invite');
    expect(body).toContain('second@example.test'); expect(body).not.toContain('first@example.test');
    if (result === 'switched') workspace='two';
    await Promise.all([confirm(), confirm()]);
    expect(calls).toBe(result === 'switched' ? 0 : 1);
    if (result === 'switched') expect(messages).toHaveLength(0);
    else expect(messages[0]).toContain(['rejected','offline'].includes(result) ? "Couldn't" : 'on its way');
    expect(JSON.stringify(agents)).toBe(before);
  }
});
