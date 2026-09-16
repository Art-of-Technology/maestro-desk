import { beforeEach, expect, mock, test } from 'bun:test';
let workspace='one', pending, fail, calls, loads, host, card, button, fields, message;
mock.module('../web/js/core/api-client.js',()=>({getWorkspaceId:()=>workspace,getJwt:()=>'session',
  apiGet:async()=>{loads++;return {items:[],owners:[],hasMore:false};},
  apiPatch:async(path,body)=>{calls.push({path,body});if(pending)await new Promise(resolve=>{pending=resolve;});if(fail)throw {status:409};return {ok:true};},
}));
mock.module('../web/js/core/event-delegation.js',()=>({registerActions(){},registerChangeActions(){}}));
mock.module('../web/js/ai/reply-feedback.js',()=>({FEEDBACK_REASONS:{}}));
globalThis.window={isAdmin:()=>true,escHtml:String,escAttr:String};
globalThis.document={getElementById:id=>id==='reply-feedback-list'?host:null};
const {saveFeedbackResolution}=await import('../web/js/settings/reply-feedback.js');
beforeEach(()=>{
  workspace='one';pending=null;fail=false;calls=[];loads=0;message={textContent:''};
  host={dataset:{scope:JSON.stringify(['one','session']),request:'1',offset:'0'},isConnected:true};
  fields=Object.fromEntries(Object.entries({status:'resolved',owner:'owner',cause:'wrong_match',notes:'Fixed.',version:'0'}).map(([k,v])=>[k,{value:v,disabled:false}]));
  button={disabled:false,closest:()=>card};
  card={dataset:{id:'feedback-id',version:'3'},isConnected:true,
    querySelector:selector=>selector==='.resolution-status'?message:fields[selector.match(/name="([^"]+)"/)[1]],
    querySelectorAll:()=>[...Object.values(fields),button]};
});
test('requires cause and notes, sends version, and prevents duplicate saves',async()=>{
  fields.notes.value='';await saveFeedbackResolution({},button);expect(calls).toHaveLength(0);expect(message.textContent).toContain('Add a cause');
  fields.notes.value='Fixed.';pending=true;const saving=saveFeedbackResolution({},button);
  await saveFeedbackResolution({},button);expect(calls).toHaveLength(1);expect(button.disabled).toBe(true);
  expect(calls[0].body.version).toBe(3);pending();await saving;expect(loads).toBe(1);
});
test('conflicts preserve entered notes and offer refresh',async()=>{
  fail=true;await saveFeedbackResolution({},button);
  expect(fields.notes.value).toBe('Fixed.');expect(message.textContent).toContain('Copy your notes');expect(button.disabled).toBe(false);
});
test('stale forms and late saves cannot cross workspaces',async()=>{
  workspace='two';await saveFeedbackResolution({},button);expect(calls).toHaveLength(0);
  workspace='one';pending=true;const saving=saveFeedbackResolution({},button);workspace='two';pending();await saving;
  expect(loads).toBe(0);
});
