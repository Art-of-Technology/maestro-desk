import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../web/js/customers/privacy.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,'');
function harness(){
  const control={jwt:'session',workspace:'workspace',admin:true,hold:null,error:null};
  const calls=[],downloads=[],alerts=[],cleared=[],nodes=new Map(),actions={},listeners={};let confirm,reloads=0;
  function show(body){for(const node of nodes.values())node.isConnected=false;nodes.clear();for(const [,id] of body.matchAll(/id="([^"]+)"/g))nodes.set(id,{isConnected:true,value:'',textContent:''});}
  const context={getJwt:()=>control.jwt,getWorkspaceId:()=>control.workspace,CUSTOMERS:[{id:'M-1',_uuid:'customer-uuid',first:'<Customer>',last:'Test'}],TICKETS:[{id:'TK-1',_uuid:'ticket-uuid',customerId:'M-1'}],
    showModal:(_title,body)=>show(body),showDangerConfirm:opts=>{show(opts.bodyHtml);confirm=opts;},showToast:message=>alerts.push(message),
    registerActions:map=>Object.assign(actions,map),invalidateDraftTicket:(...args)=>cleared.push(args),
    apiGet:async path=>{calls.push({path});if(control.hold)await control.hold;if(control.error)throw control.error;return {review_required:true};},
    apiPost:async(path,body)=>{calls.push({path,body});if(control.hold)await control.hold;if(control.error)throw control.error;return {erased:true,ticketsAffected:1,messagesRedacted:2,attachmentsDeleted:0};},
    window:{isAdmin:()=>control.admin,escHtml:s=>String(s).replaceAll('<','&lt;'),alert:s=>alerts.push(s),location:{reload:()=>reloads++},dispatchEvent:e=>calls.push({event:e.type}),addEventListener:(type,fn)=>{listeners[type]=fn;}},
    document:{getElementById:id=>nodes.get(id),createElement:()=>({click(){downloads.push(this.download);},remove(){}}),body:{appendChild(){}}},
    URL:{createObjectURL:()=> 'blob:private',revokeObjectURL:()=>calls.push({revoked:true})},Blob,setTimeout:fn=>fn(),
    localStorage:{setItem:(key,value)=>calls.push({key,value})},CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail;}}};
  const api=runInNewContext(source+'\n({showGDPRModal})',context);
  return {...api,actions,control,calls,downloads,alerts,cleared,nodes,listeners,context,get confirm(){return confirm;},get reloads(){return reloads;}};
}
test('both ticket entry points resolve the customer UUID, require admin and never erase on opening',()=>{
  const a=harness();a.showGDPRModal('TK-1');expect(a.nodes.has('privacy-actions')).toBe(true);expect(a.calls).toEqual([]);
  a.showGDPRModal('TK-1','erase');expect(a.confirm.typeToConfirm).toBe('M-1');expect(a.calls).toEqual([]);
  const denied=harness();denied.control.admin=false;denied.showGDPRModal('TK-1');expect(denied.nodes.size).toBe(0);
  const missing=harness();missing.showGDPRModal('M-1');expect(missing.nodes.size).toBe(0);
  const detail=readFileSync(new URL('../web/js/tickets/detail.js',import.meta.url),'utf8');
  expect(detail).not.toContain("alert('Erasure request initiated')");expect(detail).not.toContain('td.gdprRedact');
  expect(detail).toContain("showGDPRModal(CURRENT_TICKET, 'erase')");
});
test('export downloads only after a successful response, prevents duplicate clicks and discards late results',async()=>{
  const a=harness();a.showGDPRModal('TK-1');let release;a.control.hold=new Promise(r=>{release=r;});
  const pending=a.actions['privacy.export']();await a.actions['privacy.export']();expect(a.calls).toHaveLength(1);
  release();await pending;expect(a.calls[0].path).toBe('/api/v1/customers/customer-uuid/export');
  expect(a.downloads).toEqual(['customer-M-1-review.json']);expect(a.calls.some(c=>c.revoked)).toBe(true);
  for(const change of ['workspace','close']){
    const b=harness();b.showGDPRModal('TK-1');let done;b.control.hold=new Promise(r=>{done=r;});const loading=b.actions['privacy.export']();
    if(change==='workspace')b.control.workspace='other';else b.nodes.get('privacy-actions').isConnected=false;
    done();await loading;expect(b.downloads).toEqual([]);
  }
  const failed=harness();failed.showGDPRModal('TK-1');failed.control.error=Error('Forbidden');await failed.actions['privacy.export']();
  expect(failed.downloads).toEqual([]);expect(failed.nodes.get('privacy-error').textContent).toBe('Forbidden');
});
test('confirmed erasure reports actual success and clears copies; failures never claim success',async()=>{
  const a=harness();a.showGDPRModal('TK-1','erase');a.nodes.get('privacy-reason').value='Verified request';
  let release;a.control.hold=new Promise(r=>{release=r;});const pending=a.confirm.onConfirm();await a.confirm.onConfirm();
  expect(a.calls).toHaveLength(1);release();await pending;
  expect(a.calls[0]).toEqual({path:'/api/v1/customers/customer-uuid/erase',body:{reason:'Verified request'}});
  expect(a.cleared[0]).toEqual(['TK-1',true,'workspace',null]);expect(a.reloads).toBe(1);expect(a.alerts[0]).toContain('Tickets affected: 1');
  const b=harness();b.showGDPRModal('TK-1','erase');b.control.error=Error('Unmerge duplicates first');await b.confirm.onConfirm();
  expect(b.nodes.get('privacy-error').textContent).toBe('Unmerge duplicates first');expect(b.reloads).toBe(0);expect(b.cleared).toEqual([]);
});
test('late erasure clears only its original workspace and other tabs reload only the matching workspace',async()=>{
  const a=harness();a.showGDPRModal('TK-1','erase');let release;a.control.hold=new Promise(r=>{release=r;});const pending=a.confirm.onConfirm();
  a.control.workspace='other';release();await pending;expect(a.cleared[0][2]).toBe('workspace');expect(a.reloads).toBe(0);expect(a.alerts).toEqual([]);
  a.listeners.storage({key:'respovia:customer-erased-record',newValue:JSON.stringify({workspace:'workspace'})});expect(a.reloads).toBe(0);
  a.listeners.storage({key:'respovia:customer-erased-record',newValue:JSON.stringify({workspace:'other'})});expect(a.reloads).toBe(1);
  const b=harness();b.showGDPRModal('TK-1','erase');b.control.jwt='another-session';await b.confirm.onConfirm();expect(b.calls).toEqual([]);
});
