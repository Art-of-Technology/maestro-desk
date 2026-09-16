import {beforeEach,expect,mock,test} from 'bun:test';
import {handoverFingerprint,handoverInput,handoverStale,handoverText,parseHandover} from '../web/js/ai/handover.js';
const tickets=[];let workspace='one',release,calls,answer;
mock.module('../web/js/core/data.js',()=>({TICKETS:tickets}));
mock.module('../web/js/core/state.js',()=>({CURRENT_TICKET:'T1'}));
mock.module('../web/js/core/api-client.js',()=>({getWorkspaceId:()=>workspace,getJwt:()=>'user'}));
mock.module('../web/js/tickets/detail.js',()=>({openTicket(){}}));
mock.module('../web/js/ai/client.js',()=>({callClaude:async()=>{calls++;if(release)await new Promise(r=>{release=r;});return {text:answer};}}));
const {summarizeTicket,clearTicketSummary}=await import('../web/js/ai/summarize.js');
const fixture=()=>({id:'T1',subject:'Account question',status:'open',msgs:[{_uuid:'m1',r:'customer',t:'Can you help me?',from:'Sam'}]});
const result={tldr:'Customer needs account help.',issue:'Account access',done:'Not recorded',unanswered:['Can the customer access their account?'],nextSteps:['Check the reported access error.']};
beforeEach(()=>{workspace='one';release=null;calls=0;answer=JSON.stringify(result);tickets.length=0;});
test('stale checks detect edits, removals and changed ticket metadata',()=>{
  for(const change of [t=>{t.msgs[0].t='Different question';},t=>{t.msgs=[];},t=>{t.status='resolved';},t=>{t.agent='Other';}]){
    const t=fixture();t.aiSummary={sourceFingerprint:handoverFingerprint(t)};expect(handoverStale(t)).toBe(false);change(t);expect(handoverStale(t)).toBe(true);
  }
});
test('bounded input includes internal notes and explicitly identifies truncation',()=>{
  const t=fixture();t.msgs.push({r:'note',t:'Waiting for the specialist.'});
  expect(handoverInput(t).transcript).toContain('Internal note');
  t.msgs=Array.from({length:100},(_,i)=>({r:'customer',t:String(i).repeat(2000)}));
  const input=handoverInput(t);expect(input.truncated).toBe(true);expect(input.transcript.length).toBeLessThanOrEqual(48000);expect(input.coveredMsgCount).toBeLessThanOrEqual(40);
  t.msgs=[{r:'customer',t:'x'.repeat(60000)}];expect(handoverInput(t).truncated).toBe(true);expect(handoverInput(t).transcript.length).toBeLessThan(48000);
});
test('requires structured bounded output and marks copied stale handovers',()=>{
  expect(parseHandover(answer)).toEqual(result);
  for(const value of [{}, {...result,unanswered:'text'},{...result,nextSteps:['x'.repeat(501)]}])expect(()=>parseHandover(JSON.stringify(value))).toThrow();
  const t=fixture();t.aiSummary={...result,sourceFingerprint:handoverFingerprint(t),truncated:true};t.msgs[0].t='Edited';
  const text=handoverText(t);expect(text).toContain('OUTDATED');expect(text).toContain('earlier context');expect(text).toContain('Next steps:');
});
test('deduplicates requests and keeps a new message visible as an outdated summary',async()=>{
  const t=fixture();tickets.push(t);release=true;const task=summarizeTicket('T1');await summarizeTicket('T1');expect(calls).toBe(1);
  t.msgs.push({r:'customer',t:'Another question'});release();await task;
  expect(t.aiSummary.unanswered).toEqual(result.unanswered);expect(handoverStale(t)).toBe(true);
});
test('late responses cannot cross workspaces or restore a cleared summary',async()=>{
  for(const clear of [false,true]){
    workspace='one';tickets.length=0;const t=fixture();tickets.push(t);release=true;
    const task=summarizeTicket('T1');if(clear)clearTicketSummary('T1');else workspace='two';release();await task;
    expect(t.aiSummary).toBeUndefined();
  }
});
test('invalid output leaves a retryable error',async()=>{
  const t=fixture();tickets.push(t);answer='invalid';await summarizeTicket('T1');expect(t.aiSummary.error).toContain('Try again');
  answer=JSON.stringify(result);await summarizeTicket('T1');expect(t.aiSummary.tldr).toBe(result.tldr);
});
