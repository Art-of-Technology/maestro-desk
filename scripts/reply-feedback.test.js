import { beforeEach, test, expect, mock } from 'bun:test';
let workspace = 'a0000000-0000-4000-8000-000000000001', jwt='agent', review, calls, fail, release;
const suggestionId='a0000000-0000-4000-8000-000000000002';
const status={textContent:''};
const select={value:'wrong_match',disabled:false};
const buttons=[true,false].map(value=>({dataset:{helpful:String(value)},disabled:false,setAttribute(k,v){this[k]=v;}}));
const panel={dataset:{suggestionId},isConnected:true,querySelector:s=>s==='[role="status"]'?status:select,
  querySelectorAll:s=>s==='button'?buttons:[...buttons,select]};
const button={closest:()=>panel};
globalThis.window={escAttr:String,escHtml:s=>String(s).replaceAll('<','&lt;'),isAdmin:()=>true};
let host;
globalThis.document={getElementById:()=>host};
mock.module('../web/js/core/state.js',()=>({COMPOSE_TAB:'reply'}));
mock.module('../web/js/core/event-delegation.js',()=>({registerActions(){},registerChangeActions(){}}));
mock.module('../web/js/tickets/drafts.js',()=>({loadDraftReview:()=>review,saveDraftReview:(_id,v)=>{review=v;}}));
let listing;
mock.module('../web/js/core/api-client.js',()=>({getWorkspaceId:()=>workspace,getJwt:()=>jwt,
  apiPost:async (_url,body)=>{calls++; if(release) await new Promise(resolve=>{release=resolve;}); if(fail) throw Error('offline'); return body;},
  apiGet:async ()=>{if(release) await new Promise(resolve=>{release=resolve;}); if(fail) throw Error('offline'); return listing;}}));
const {renderReplyFeedback,rateReply}=await import('../web/js/ai/reply-feedback.js');
const {loadReplyFeedback}=await import('../web/js/settings/reply-feedback.js');
beforeEach(()=>{workspace='a0000000-0000-4000-8000-000000000001';jwt='agent';review={suggestionId,references:[],notes:[]};calls=0;fail=false;release=null;panel.isConnected=true;status.textContent='';});
test('offers labelled ratings and optional reasons only for server-issued suggestions',()=>{
  expect(renderReplyFeedback('T1',review)).toContain('Was this suggestion helpful?');
  expect(renderReplyFeedback('T1',review)).toContain('Reason (optional)');
  expect(renderReplyFeedback('T1',{suggestionId:'<script>'})).toBe('');
});
test('saves a rating without replacing the review, suppresses double clicks and permits correction',async()=>{
  release=true;
  const pending=rateReply({ticketId:'T1',helpful:'false'},button);
  await rateReply({ticketId:'T1',helpful:'false'},button); expect(calls).toBe(1);
  release(); await pending;release=null;
  expect(review.feedback).toEqual({helpful:false,reason:'wrong_match'});
  expect(review.references).toEqual([]); expect(status.textContent).toContain('saved');
  await rateReply({ticketId:'T1',helpful:'true'},button);
  expect(review.feedback).toEqual({helpful:true,reason:null});
});
test('failed saves are retryable and leave existing feedback intact',async()=>{
  review.feedback={helpful:true,reason:null};fail=true;
  await rateReply({ticketId:'T1',helpful:'false'},button);
  expect(review.feedback.helpful).toBe(true);expect(status.textContent).toContain('wasn’t saved');
  expect(buttons[0].disabled).toBe(false);
});
test('late saves cannot overwrite a new suggestion or another workspace draft',async()=>{
  for(const change of [()=>{review={suggestionId:'new',notes:[],references:[]};},()=>{workspace='other';}]) {
    review={suggestionId,notes:[],references:[]};workspace='original';release=true;
    const pending=rateReply({ticketId:'T1',helpful:'false'},button);
    change();release();await pending;release=null;
    expect(review.feedback).toBeUndefined();
  }
});
test('admin view escapes reply text, shows sources, and handles empty and error states',async()=>{
  host={dataset:{},isConnected:true,innerHTML:''};
  listing={hasMore:false,items:[{ticket_id:suggestionId,display_id:'T1',subject:'Question',reply:'<script>bad</script>',reason:'wrong_match',updated_at:'2026-09-16',sources:[]}]};
  await loadReplyFeedback();expect(host.innerHTML).toContain('&lt;script>');expect(host.innerHTML).not.toContain('<script>');
  listing={hasMore:false,items:[]};await loadReplyFeedback();expect(host.innerHTML).toContain('No suggestions');
  fail=true;await loadReplyFeedback();expect(host.innerHTML).toContain('Try again');
});
test('admin view drops stale workspace results',async()=>{
  host={dataset:{},isConnected:true,innerHTML:''};listing={hasMore:false,items:[]};release=true;
  const pending=loadReplyFeedback();workspace='other';release();await pending;
  expect(host.innerHTML).toBe('<p>Loading feedback…</p>');
});
