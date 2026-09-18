import { apiGet, getWorkspaceId, getJwt } from '../core/api-client.js';
import { registerActions } from '../core/event-delegation.js';
import { downloadCSV } from '../core/csv.js';
import { formatRoute } from '../core/route-location.js';

const reasons = {wrong_match:'Wrong match',outdated_advice:'Outdated advice',wrong_language:'Wrong language',other:'Other',none:'No reason given'};
const esc = value => window.escHtml(String(value ?? ''));
const money = micro => '$' + (Number(micro)/1e6).toFixed(4);
const ratio = (n,d) => d ? (100*n/d).toFixed(1)+'%' : 'Unavailable';
const minutes = seconds => seconds == null ? 'Unavailable' : (Number(seconds)/60).toFixed(1)+' min';
const outcomeLabel=r=>r.sent_at?(r.sent_change_ratio==null?'Accepted · change not recorded':r.sent_change_ratio>=0.3?'Accepted · substantial change':'Accepted · minor or no change'):r.rejected_at?'Explicitly rejected':'Not recorded';
let current = null, sequence = 0;

export function renderReplyPerformance() {
  current = null;
  if (!window.isAdmin()) return '<div class="page"><p>Admin permission is required to view AI reply performance.</p></div>';
  const end = new Date(), start = new Date(end); start.setUTCDate(start.getUTCDate()-29);
  setTimeout(() => loadPerformance(),0);
  return `<div class="page ai-performance-page"><div class="topbar"><button type="button" class="btn" data-action="reports.closeAi">← Reports</button><h1 class="tb-title">AI reply performance</h1></div>
    <div class="page-scroll ai-performance" id="ai-performance">
      <div class="performance-filters">
        <label>From (UTC)<input type="date" class="form-input" id="reply-report-start" value="${start.toISOString().slice(0,10)}"></label>
        <label>Through (UTC)<input type="date" class="form-input" id="reply-report-end" value="${end.toISOString().slice(0,10)}"></label>
        <label>Agent<select class="form-input" id="reply-report-agent"><option value="">All agents</option></select></label>
        <label>Rating<select class="form-input" id="reply-report-rating"><option value="all">All ratings</option><option value="helpful">Helpful</option><option value="not_helpful">Not helpful</option><option value="unrated">Not rated</option></select></label>
        <label>Reason<select class="form-input" id="reply-report-reason"><option value="all">All reasons</option>${Object.entries(reasons).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>Requested reply language<select class="form-input" id="reply-report-language"><option value="">All languages</option></select></label>
        <label>Query type (ticket category)<select class="form-input" id="reply-report-query_type"><option value="">All types</option></select></label>
        <label>Outcome<select class="form-input" id="reply-report-outcome"><option value="all">All outcomes</option><option value="accepted">Accepted (confirmed use)</option><option value="substantial">Accepted with substantial change</option><option value="rejected">Explicitly rejected</option><option value="unrecorded">No outcome recorded</option></select></label>
        <button type="button" class="btn btn-primary" data-action="replyPerformance.load">Apply filters</button>
      </div>
      <div class="performance-exports"><button type="button" class="btn" data-action="replyPerformance.summary">Export summary CSV</button><button type="button" class="btn" data-action="replyPerformance.details">Export detailed CSV</button></div>
      <p id="reply-report-status" role="status">Loading report…</p>
      <p class="performance-explainer">Grouped by suggestion creation date. Ratings reflect the latest feedback. Confirmed use means an agent sent the active shared AI draft. Posting does not confirm email delivery.</p>
      <div id="reply-report-result"></div>
    </div></div>`;
}

export function reportFilters(values) {
  const start = new Date(values.start+'T00:00:00Z'), end = new Date(values.end+'T00:00:00Z');
  if (!values.start || !values.end || !Number.isFinite(+start) || !Number.isFinite(+end)
    || start.toISOString().slice(0,10)!==values.start || end.toISOString().slice(0,10)!==values.end
    || end<start || end-start>=366*86400000) throw Error('Choose a valid date range of up to 366 days.');
  end.setUTCDate(end.getUTCDate()+1);
  return {start:start.toISOString(),end:end.toISOString(),agent:values.agent,rating:values.rating,reason:values.reason,
    language:values.language||'',query_type:values.query_type||'',outcome:values.outcome||'all'};
}
function readFilters() {
  return reportFilters(Object.fromEntries(['start','end','agent','rating','reason','language','query_type','outcome'].map(k=>[k,document.getElementById('reply-report-'+k).value])));
}
const queryString = filters => new URLSearchParams(filters).toString();
function table(headers, rows) {
  return `<div class="performance-table"><table><thead><tr>${headers.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
function metricCells(s) {
  return [s.generated,s.tracked,s.shown,s.rated,s.helpful,s.not_helpful,ratio(s.helpful,s.rated),s.used,ratio(s.used,s.tracked),s.changed,s.unchanged,minutes(s.median_seconds),money(s.cost_micro),s.used ? money(s.cost_micro/s.used) : 'Unavailable',s.wrong_match,s.outdated_advice,s.wrong_language,s.other,s.no_reason,s.substantial??0,s.change_unavailable??0,s.rejected??0,s.generated-s.used-(s.rejected??0)];
}
const metricHeaders = ['Recorded suggestions','Use-tracked suggestions','Shown','Rated','Helpful','Not helpful','Helpful rate','Confirmed uses','Use rate','Changed','Unchanged','Median time to post','Generation cost (USD)','Cost per confirmed use (USD)','Wrong match','Outdated advice','Wrong language','Other reason','No reason'];
metricHeaders.push('Substantial changes','Change measurement unavailable','Explicitly rejected','No outcome recorded');
const screenHeaders=['Suggestions','Shown','Rated','Helpful rate','Confirmed uses','Use rate','Median time to post','Cost per use (USD)','Substantial changes','Explicitly rejected'];

export function renderPerformanceData(data,workspace,offset=0) {
  const s=data.summary;
  const kpis=[['Recorded suggestions',s.generated],['Helpful rate',ratio(s.helpful,s.rated)],['Confirmed uses',s.used],['Use rate',ratio(s.used,s.tracked)],['Median time to post',minutes(s.median_seconds)],['Cost per confirmed use',s.used?money(s.cost_micro/s.used):'Unavailable']];
  const statsRows = rows => rows.map(r=>`<tr><th scope="row">${esc(r.agent_name || r.day || r.reply_language || r.query_type)}</th>${[r.generated,r.shown,r.rated,ratio(r.helpful,r.rated),r.used,ratio(r.used,r.tracked),minutes(r.median_seconds),r.used?money(r.cost_micro/r.used):'Unavailable',r.substantial??0,r.rejected??0].map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`);
  return `<div class="performance-kpis">${kpis.map(([label,value])=>`<div class="card"><strong>${esc(value)}</strong><span>${label}</span></div>`).join('')}</div>
    <p>${s.shown} shown · ${s.rated} rated · ${s.helpful} helpful · ${s.not_helpful} not helpful · ${s.generated-s.tracked} with usage tracking unavailable.</p>
    <p>${s.substantial??0} accepted with substantial changes · ${s.rejected??0} explicitly rejected · ${s.generated-s.used-(s.rejected??0)} with no outcome recorded · ${s.change_unavailable??0} accepted with change measurement unavailable.</p>
    <p class="performance-explainer">Accepted means confirmed use when posted. Substantial change is a subset of accepted replies: at least 30% text difference using character-pair overlap, ignoring case and repeated whitespace. It includes translation and is not a quality score. Rejection requires the agent's explicit choice; no rating or no use is not rejection. Language is the requested reply language and query type is the ticket category at generation, not a new AI classification. Older records may be unavailable.</p>
    <p class="performance-explainer">Helpful rate = helpful ÷ rated. Use rate = confirmed uses ÷ use-tracked suggestions. Time to post is elapsed time, not active work or time saved. “Changed” includes translation and whitespace-normalized text changes. Generation cost is ${money(s.cost_micro)} across ${s.cost_known} records; it excludes later editing, translation and unrecorded requests. Cost per use includes unused recorded suggestions. Missing show events are not proof a suggestion was unseen. Deleted records are excluded.</p>
    ${!s.generated?'<p>No suggestions match these filters. Change the date range or clear a filter.</p>':`<h2>By agent</h2>${table(['Agent',...screenHeaders],statsRows(data.agents))}
    <h2>Daily trend (UTC)</h2>${table(['Date',...screenHeaders],statsRows(data.trend))}
    <h2>By requested reply language</h2>${table(['Language',...screenHeaders],statsRows(data.languages||[]))}
    <h2>By query type (ticket category)</h2>${table(['Query type',...screenHeaders],statsRows(data.queryTypes||[]))}
    <h2>Reported problems</h2>${data.reasons.length?`<ul>${data.reasons.map(r=>`<li>${reasons[r.reason] || 'No reason given'}: ${r.count}</li>`).join('')}</ul>`:'<p>No negative ratings in this selection.</p>'}
    <h2>Suggestion details</h2><p>${offset+1}–${offset+data.details.length} of ${s.generated}</p>
    ${table(['Ticket','Agent','Created (UTC)','Rating / reason','Shown','Confirmed use','Text at posting','Outcome','Language','Query type','Elapsed'],data.details.map(r=>`<tr><td><a href="${window.escAttr(formatRoute({workspaceId:workspace,page:'tickets',entityId:r.ticket_id}))}">${esc(r.display_id)}</a></td><td>${esc(r.agent_name)}</td><td>${esc(r.created_at)}</td><td>${r.helpful===null?'Not rated':r.helpful?'Helpful':'Not helpful'}${r.reason?' / '+esc(reasons[r.reason]):''}</td><td>${r.shown_at?'Recorded':'Not recorded'}</td><td>${r.reply_context!=='reply'?'Unavailable':r.sent_at?'Yes':'Not recorded'}</td><td>${r.sent_at?(r.sent_changed?'Changed':'Unchanged'):'Unavailable'}</td><td>${esc(outcomeLabel(r))}</td><td>${esc(r.reply_language||'Not recorded')}</td><td>${esc(r.query_type||'Not recorded')}</td><td>${minutes(r.elapsed_seconds)}</td></tr>`))}
    <div class="performance-exports">${offset?`<button type="button" class="btn" data-action="replyPerformance.page" data-offset="${Math.max(0,offset-50)}">Previous</button>`:''}${data.hasMore?`<button type="button" class="btn" data-action="replyPerformance.page" data-offset="${offset+50}">Next</button>`:''}</div>`}`;
}

export async function loadPerformance(offset=0) {
  const host=document.getElementById('ai-performance');
  if (!host || !window.isAdmin()) return;
  const workspace=getWorkspaceId(),jwt=getJwt(),request=++sequence;
  const active=()=>host===document.getElementById('ai-performance') && host.isConnected && request===sequence
    && workspace===getWorkspaceId() && jwt===getJwt() && window.isAdmin();
  const status=document.getElementById('reply-report-status'),result=document.getElementById('reply-report-result');
  try {
    const filters=readFilters();
    if (current && queryString(filters)!==queryString(current.filters)) offset=0;
    current=null;result.innerHTML='';status.textContent='Loading report…';
    const data=await apiGet('/api/v1/reports/reply-performance?'+queryString({...filters,offset}));
    if (!active()) return;
    if(queryString(readFilters())!==queryString(filters)){status.textContent='Filters changed. Apply filters again.';return;}
    const agent=document.getElementById('reply-report-agent');
    agent.innerHTML='<option value="">All agents</option>'+data.agentOptions.map(a=>`<option value="${window.escAttr(a.id)}">${esc(a.name)}</option>`).join('');
    if(filters.agent && !data.agentOptions.some(a=>a.id===filters.agent))
      agent.insertAdjacentHTML('beforeend',`<option value="${window.escAttr(filters.agent)}">Selected agent (no suggestions)</option>`);
    agent.value=filters.agent;
    for(const [key,choices,label] of [['language',data.languageOptions||[],'All languages'],['query_type',data.queryTypeOptions||[],'All types']]) {
      const select=document.getElementById('reply-report-'+key);
      const values=[...new Set([...choices,...(filters[key]?[filters[key]]:[])])];
      select.innerHTML=`<option value="">${label}</option>`+values.map(value=>`<option value="${window.escAttr(value)}">${esc(value)}</option>`).join('');
      select.value=filters[key];
    }
    current={data,filters,workspace,jwt,host};
    result.innerHTML=renderPerformanceData(data,workspace,offset);
    status.textContent='Report loaded. Exports use these filters.';
  } catch(error) {
    if(active()){current=null;result.innerHTML='';status.textContent=error?.status===400?error.message:error?.message?.startsWith('Choose')?error.message:'Report couldn’t be loaded. Check the filters and try Apply filters again.';}
  }
}

// Guard whitespace-prefixed spreadsheet formulas as well as ordinary CSV quotes.
export function safeReportCell(value) { const s=String(value??'');return /^[\s\uFEFF]*[=+@-]/.test(s)||/^[\t\r\n]/.test(s)?"'"+s:s; }
export function reportSummaryRows(data) {
  return [['Overall','All agents',...metricCells(data.summary)],...data.agents.map(s=>['Agent',s.agent_name,...metricCells(s)]),...data.trend.map(s=>['Day (UTC)',s.day,...metricCells(s)]),
    ...(data.languages||[]).map(s=>['Requested language',s.reply_language,...metricCells(s)]),...(data.queryTypes||[]).map(s=>['Query type',s.query_type,...metricCells(s)])];
}
export function reportDetailRows(data,workspace) {
  return data.details.map(r=>[r.id,r.display_id,r.agent_name,r.created_at,r.helpful===null?'Not rated':r.helpful?'Helpful':'Not helpful',reasons[r.reason]||'',r.rated_at||'',r.shown_at||'',r.reply_context==='reply'?'Available':'Unavailable',r.sent_at||'',r.sent_at?(r.sent_changed?'Changed':'Unchanged'):'Unavailable',r.elapsed_seconds??'',r.generation_cost_micro==null?'Unavailable':(r.generation_cost_micro/1e6).toFixed(6),outcomeLabel(r),r.sent_change_ratio??'',r.rejected_at||'',r.reply_language||'Not recorded',r.query_type||'Not recorded',location.origin+'/'+formatRoute({workspaceId:workspace,page:'tickets',entityId:r.ticket_id})]);
}
export async function exportPerformance(detail=false) {
  const snapshot=current,status=document.getElementById('reply-report-status');
  if(!status)return;
  const active=()=>snapshot && snapshot===current && snapshot.host===document.getElementById('ai-performance')
    && snapshot.workspace===getWorkspaceId() && snapshot.jwt===getJwt() && window.isAdmin();
  try {
    if(!active() || queryString(readFilters())!==queryString(snapshot.filters)) throw Error('Apply filters before exporting.');
    status.textContent='Preparing CSV…';
    const data=detail?await apiGet('/api/v1/reports/reply-performance?'+queryString({...snapshot.filters,export:'details'})):snapshot.data;
    if(!active()) return;
    if(queryString(readFilters())!==queryString(snapshot.filters)){status.textContent='Filters changed. Apply filters before exporting.';return;}
    const headers=detail?['Suggestion ID','Ticket','Agent','Created UTC','Rating','Reason','Rated UTC','Shown UTC','Usage tracking','Posted UTC','Text at posting','Elapsed seconds','Generation cost USD','Outcome','Text change ratio','Rejected UTC','Requested language','Query type (category at generation)','Ticket link']:['Breakdown','Name / date',...metricHeaders];
    const rows=detail?reportDetailRows(data,snapshot.workspace):reportSummaryRows(data);
    downloadCSV(headers,rows.map(row=>row.map(safeReportCell)),`ai-reply-${detail?'details':'summary'}-${snapshot.filters.start.slice(0,10)}.csv`);
    status.textContent='CSV exported.';
  } catch(error) { if(!snapshot || active())status.textContent=error?.status===422?error.message:error.message==='Apply filters before exporting.'?error.message:'Export failed. Try again.'; }
}
registerActions({
  'replyPerformance.load':()=>loadPerformance(), 'replyPerformance.page':ds=>loadPerformance(Number(ds.offset)||0),
  'replyPerformance.summary':()=>exportPerformance(), 'replyPerformance.details':()=>exportPerformance(true),
});
