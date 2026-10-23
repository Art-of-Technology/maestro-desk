import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/js/tickets/new-ticket.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('async function confirmSend('), source.indexOf('async function createOnServer('));

test('new-ticket closure requires a message, a valid reason and confirmed sending', async () => {
  for (const scenario of ['sent','empty','reason-missing','creation-failed','send-failed','unconfirmed','close-failed','switched']) {
    let workspace='one', created=0, closed=0, wizardClosed=false, opened=0, retry=0, reminders=0;
    const state={busy:false,closeAfterSend:true,closeReason:'',replyLanguage:'Spanish',customer:{uuid:'customer',displayId:'M1'},files:[]};
    const form={value:scenario==='empty'?'':'Hello',isConnected:true};
    const button={textContent:''}, error={textContent:'',closest:()=>({querySelector:()=>button})};
    const ticket={id:'TK-NEW',_uuid:'ticket'};
    const context={
      NT:state,TICKETS:[ticket],CURRENT_TICKET:null,
      document:{getElementById:id=>id==='nt2-msg'?form:id==='closure-error'?error:{value:scenario==='reason-missing'?'':'other',focus(){}}},
      required:()=>false,alert(){},window:{confirm:()=>true},setBusy:v=>{state.busy=v;},
      getWorkspaceId:()=>workspace,getJwt:()=> 'session',isSessionApiBacked:()=>true,
      loadStatusOptions:async()=>{},statusOptionsState:()=>({ready:true}),statusChoice:()=>({is_active:true,reason_required:true,reasons:[{key:'other',is_active:true}]}),
      prepareCustomerReply:async()=>({translation:'Hola',replyLanguage:'Spanish'}),
      createOnServer:async()=>{created++;if(scenario==='switched')workspace='two';return scenario==='creation-failed'?null:{displayId:ticket.id,keptDraft:scenario==='send-failed',emailed:['sent','close-failed'].includes(scenario)};},
      apiPost:async()=>{closed++;if(scenario==='close-failed')throw Error('Close unavailable');return {ticket:{status_key:'closed'}};},
      applyClosedTicket:t=>{t.status='closed';},showCloseTickets:()=>{retry++;},
      markCloseReminder:()=>{reminders++;},
      closeModal:()=>{wizardClosed=true;},resetNT(){},updateNavBadges(){},showToast(){},console:{error(){}},
      setComposeTabValue(){},openTicket:id=>{opened++;context.CURRENT_TICKET=id;},loadTicketDetail:async()=>{},
    };
    await runInNewContext(functions+'confirmSend()',context);
    const blocked=['empty','reason-missing'].includes(scenario);
    expect(created).toBe(blocked?0:1);
    expect(closed).toBe(['sent','close-failed'].includes(scenario)?1:0);
    expect(reminders).toBe(['sent','close-failed'].includes(scenario)?1:0);
    if(scenario==='sent')expect(ticket.status).toBe('closed');
    if(scenario==='close-failed') {expect(retry).toBe(1);expect(button.textContent).toBe('Retry close only');expect(created).toBe(1);}
    if(['send-failed','unconfirmed'].includes(scenario)){expect(wizardClosed).toBe(true);expect(opened).toBe(1);expect(ticket.status).not.toBe('closed');}
    if(scenario==='creation-failed')expect(wizardClosed).toBe(false);
    if(scenario==='switched')expect(opened).toBe(0);
  }
});
