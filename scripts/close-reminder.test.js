import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source=readFileSync(new URL('../web/js/tickets/close-reminder.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export ','');
function device(server, saved, overrides={}) {
  const storage=new Map(saved||[]), calls=[], warnings=[];
  const scope={workspace:'one',jwt:'session',user:'agent'}, ticket={id:'TK-001',_uuid:'ticket',status:'open'};
  const context={Map,Promise,AbortSignal,JSON,Number,SESSION:{get userId(){return scope.user;}},CURRENT_TICKET:ticket.id,
    getWorkspaceId:()=>scope.workspace,getJwt:()=>scope.jwt,
    document:{getElementById:()=>null},window:{escAttr:String},showToast:m=>warnings.push(m),
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    apiGet:async()=>({reminder:{...server}}),
    apiPut:async(path,body)=>{calls.push(body);if(body.version!==server.version)throw {status:409,body:{reminder:{...server}}};Object.assign(server,{pending:body.pending,version:server.version+1});return {reminder:{...server}};},
    ...overrides,
  };
  const api=runInNewContext(source+';({markCloseReminder,clearCloseReminder,dismissCloseReminder,loadCloseReminder,closeReminder})',context);
  return {...api,scope,ticket,storage,calls,warnings};
}
const key='close-reminder:v1:one:agent:ticket';
test('two devices share reminders, dismissal and conflict-safe clearing',async()=>{
  const server={pending:false,version:0,generation:0},a=device(server),b=device(server);
  await a.markCloseReminder(a.ticket);
  expect(JSON.parse(a.storage.get(key))).toEqual({pending:true,version:1,generation:0,dirty:false});
  await b.loadCloseReminder(b.ticket);expect(b.closeReminder(b.ticket)).toContain('Retry close only');
  await b.dismissCloseReminder(b.ticket);expect(server).toEqual({pending:false,version:2,generation:0});
  await a.loadCloseReminder(a.ticket,{force:true});expect(a.closeReminder(a.ticket)).toBe('');
  expect([...a.storage.values()].every(v=>!v.includes('Email sent'))).toBe(true);
});
test('legacy browser markers import once, and server tombstones defeat stale imports',async()=>{
  const server={pending:false,version:0,generation:0},a=device(server,[[key,'1']]);
  await a.loadCloseReminder(a.ticket);expect(server).toEqual({pending:true,version:1,generation:0});expect(a.calls).toHaveLength(1);
  Object.assign(server,{pending:false,version:2,generation:0});
  const stale=device(server,[[key,'1']]);await stale.loadCloseReminder(stale.ticket);
  expect(stale.calls).toHaveLength(0);expect(stale.closeReminder(stale.ticket)).toBe('');
});
test('offline edits retain their base version and cannot resurrect cleared state',async()=>{
  const server={pending:false,version:2,generation:0};
  const a=device(server,[[key,JSON.stringify({pending:true,version:1,generation:0,dirty:true})]]);
  await a.loadCloseReminder(a.ticket);expect(a.calls).toHaveLength(0);expect(a.closeReminder(a.ticket)).toBe('');
  expect(a.warnings).toContain('The reminder changed on another device. The latest version is shown.');
});
test('a dismissal during an in-flight save follows its acknowledgement',async()=>{
  const server={pending:false,version:0,generation:0};let release,started;
  const held=new Promise(r=>release=r),ready=new Promise(r=>started=r);let writes=0;
  const a=device(server,[],{apiPut:async(path,body)=>{writes++;if(writes===1){started();await held;}Object.assign(server,{pending:body.pending,version:server.version+1});return {reminder:{...server}};}});
  const saving=a.markCloseReminder(a.ticket);await ready;
  const dismissing=a.dismissCloseReminder(a.ticket);release();await Promise.all([saving,dismissing]);
  expect(writes).toBe(2);expect(server).toEqual({pending:false,version:2,generation:0});expect(a.closeReminder(a.ticket)).toBe('');
});
test('a closure generation prevents stale first saves and legacy imports after reopening',async()=>{
  const server={pending:false,version:0,generation:1};
  for(const saved of ['1',JSON.stringify({pending:true,version:0,generation:0,dirty:true})]) {
    const a=device(server,[[key,saved]]);await a.loadCloseReminder(a.ticket);
    expect(a.calls).toHaveLength(0);expect(a.closeReminder(a.ticket)).toBe('');
  }
});
test('offline and blocked storage keep a local notice without blocking closure',async()=>{
  const server={pending:false,version:0,generation:0};
  const a=device(server,[],{apiGet:async()=>{throw Error('Offline');}});
  await a.markCloseReminder(a.ticket);expect(a.closeReminder(a.ticket)).toContain('Retry close only');
  expect(JSON.parse(a.storage.get(key)).dirty).toBe(true);expect(a.warnings.length).toBe(1);
  a.clearCloseReminder(a.ticket);expect(a.closeReminder(a.ticket)).toBe('');
  const b=device(server,[],{apiGet:async()=>{throw Error('Offline');},localStorage:{getItem(){throw Error();},setItem(){throw Error();},removeItem(){throw Error();}}});
  await b.markCloseReminder(b.ticket);expect(b.closeReminder(b.ticket)).toContain('Retry close only');expect(b.warnings.length).toBeGreaterThan(0);
});
test('late responses cannot cross account, workspace or session boundaries',async()=>{
  for(const field of ['user','workspace','jwt']) {
    let release;const held=new Promise(r=>release=r),server={pending:true,version:1,generation:0};
    const a=device(server,[],{apiGet:async()=>{await held;return {reminder:{...server}};}});
    const loading=a.loadCloseReminder(a.ticket);a.scope[field]='other';release();await loading;
    expect(a.closeReminder(a.ticket)).toBe('');expect(a.calls).toHaveLength(0);expect(a.storage.size).toBe(0);
  }
});
test('a write conflict adopts the server response; malformed responses preserve the draft marker',async()=>{
  const server={pending:false,version:0,generation:0};
  const a=device(server,[],{apiPut:async()=>{throw {status:409,body:{reminder:{pending:false,version:3,generation:0}}};}});
  await a.markCloseReminder(a.ticket);expect(a.closeReminder(a.ticket)).toBe('');expect(JSON.parse(a.storage.get(key)).version).toBe(3);
  const b=device(server,[],{apiGet:async()=>({})});await b.markCloseReminder(b.ticket);
  expect(b.closeReminder(b.ticket)).toContain('Retry close only');expect(b.calls).toHaveLength(0);
});
