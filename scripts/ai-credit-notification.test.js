import { test, expect, mock } from 'bun:test';
let workspace='one', token='one', admin=true, now=50000, calls=[];
globalThis.window={isAdmin:()=>admin};
mock.module('../web/js/core/api-client.js',()=>({getWorkspaceId:()=>workspace,getJwt:()=>token,
  apiGet:()=>new Promise(resolve=>calls.push(resolve)),apiPost:async()=>({ok:true})}));
const {creditNotification,acknowledgeCredit}=await import('../web/js/notifications/ai-credit.js');
const refresh=()=>{};
const flush=()=>new Promise(r=>setTimeout(r,0));
test('one alert per period, acknowledgement, top-up, admin-only and late workspace results',async()=>{
  const original=Date.now;Date.now=()=>now;
  try {
    expect(creditNotification(refresh)).toBeNull();expect(calls).toHaveLength(1);
    creditNotification(refresh);expect(calls).toHaveLength(1);
    calls[0]({alert:{since:'first',balance_micro:1500000,read:false,dismissed:false}});await flush();
    const first=creditNotification(refresh);expect(first.body).toContain('$1.50');
    await acknowledgeCredit(first.id);expect(creditNotification(refresh).read).toBe(true);
    await acknowledgeCredit(first.id,true);expect(creditNotification(refresh)).toBeNull();
    now+=30000;creditNotification(refresh);calls[1]({alert:null});await flush();expect(creditNotification(refresh)).toBeNull();
    now+=30000;creditNotification(refresh);calls[2]({alert:{since:'second',balance_micro:1000000,read:false}});await flush();
    expect(creditNotification(refresh).id).not.toBe(first.id);expect(creditNotification(refresh).read).toBe(false);
    now+=30000;creditNotification(refresh);workspace='two';expect(creditNotification(refresh)).toBeNull();
    calls[3]({alert:{since:'old-workspace',balance_micro:0}});await flush();expect(creditNotification(refresh)).toBeNull();
    calls[4]({alert:null});await flush();admin=false;const count=calls.length;now+=30000;
    expect(creditNotification(refresh)).toBeNull();expect(calls).toHaveLength(count);
    token=null;expect(creditNotification(refresh)).toBeNull();
  } finally {Date.now=original;}
});
