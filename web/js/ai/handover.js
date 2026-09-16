export function handoverFingerprint(ticket) {
  return JSON.stringify([ticket.subject,ticket.status,ticket.priority,ticket.category,ticket.agent,ticket.customerId,
    (ticket.msgs||[]).map(m=>[m._uuid,m.r,m.from,m.t??m.tOriginal])]);
}
export function handoverStale(ticket,summary=ticket.aiSummary) {
  if(!summary)return false;
  return summary.sourceFingerprint ? summary.sourceFingerprint!==handoverFingerprint(ticket)
    : summary.coveredMsgCount!==undefined && summary.coveredMsgCount!==(ticket.msgs||[]).length;
}
export function handoverInput(ticket) {
  const messages=(ticket.msgs||[]).filter(m=>['customer','agent','note','ai'].includes(m.r));
  const selected=messages.slice(-40),lines=[];
  let budget=48000,truncated=selected.length<messages.length;
  for(let i=selected.length-1;i>=0;i--){
    const m=selected[i],line=`[${messages.length-selected.length+i+1}] ${m.r==='note'?'Internal note':m.r}: ${m.t??m.tOriginal??''}`;
    if(line.length>budget){truncated=true;break;}
    lines.unshift(line);budget-=line.length+2;
  }
  if(!lines.length && selected.length){
    const m=selected.at(-1);lines.push(`[Last message excerpt · ${m.r}] ${String(m.t??m.tOriginal??'').slice(-47000)}`);truncated=true;
  }
  return {transcript:lines.join('\n\n'),coveredMsgCount:lines.length,totalMsgCount:messages.length,truncated};
}
export function parseHandover(raw) {
  const value=JSON.parse(String(raw||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
  const text=(key,max)=>{if(typeof value?.[key]!=='string'||!value[key].trim()||value[key].length>max)throw Error('Invalid handover');return value[key].trim();};
  const list=key=>{if(!Array.isArray(value?.[key])||value[key].length>5||value[key].some(v=>typeof v!=='string'||!v.trim()||v.length>500))throw Error('Invalid handover');return value[key].map(v=>v.trim());};
  return {tldr:text('tldr',1200),issue:text('issue',500),done:text('done',500),unanswered:list('unanswered'),nextSteps:list('nextSteps')};
}
export function handoverText(ticket) {
  const s=ticket.aiSummary;
  if(!s||s.error||s.summarizing)return '';
  return [`Internal handover — ${ticket.id}`,`Generated: ${s.generatedAt||'Not recorded'}`,
    handoverStale(ticket,s)?'OUTDATED: the conversation or ticket details have changed. Refresh before relying on this.':'AI summary — verify against the conversation.',
    s.truncated?'Limited to the latest messages; earlier context is not included.':'',s.tldr,`Issue: ${s.issue}`,`Done: ${s.done}`,
    'Unanswered questions:',...(s.unanswered?.length?s.unanswered.map(v=>'- '+v):['None identified; verify against the conversation.']),
    'Next steps:',...(s.nextSteps?.length?s.nextSteps.map(v=>'- '+v):[s.next||'Review the conversation before deciding.'])].filter(Boolean).join('\n');
}
