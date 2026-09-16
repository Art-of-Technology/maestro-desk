import {test,expect,mock,beforeEach} from 'bun:test';
let workspace='a0000000-0000-4000-8000-000000000001',jwt='test',release=null,response,fail=false,downloads=[];
const elements={};
globalThis.document={getElementById:id=>elements[id]};
globalThis.window={isAdmin:()=>true,escHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),escAttr:s=>String(s).replaceAll('"','&quot;')};
globalThis.location={origin:'https://app.example.test'};
mock.module('../web/js/core/api-client.js',()=>({getWorkspaceId:()=>workspace,getJwt:()=>jwt,apiGet:async()=>{if(release)await new Promise(r=>{release=r;});if(fail)throw Error('offline');return response;}}));
mock.module('../web/js/core/event-delegation.js',()=>({registerActions(){}}));
mock.module('../web/js/core/csv.js',()=>({downloadCSV:(...args)=>downloads.push(args)}));
const {reportFilters,renderPerformanceData,safeReportCell,reportSummaryRows,reportDetailRows,loadPerformance,exportPerformance}=await import('../web/js/reports/reply-performance.js');
const metrics={generated:4,tracked:3,shown:2,rated:2,helpful:1,not_helpful:1,used:1,changed:1,unchanged:0,cost_known:3,cost_micro:6000,median_seconds:120};
const fixture=()=>({summary:{...metrics},agents:[{...metrics,agent_name:'<script>Agent</script>'}],trend:[{...metrics,day:'2026-09-01'}],reasons:[{reason:'wrong_match',count:1}],agentOptions:[],hasMore:false,
  details:[{id:'one',ticket_id:'a0000000-0000-4000-8000-000000000002',display_id:'TK-1',agent_name:'=bad',created_at:'2026-09-01T00:00:00Z',helpful:false,reason:'wrong_match',reply_context:'reply',sent_at:'2026-09-01T00:02:00Z',sent_changed:true,elapsed_seconds:120,generation_cost_micro:2000}]});
beforeEach(()=>{
  workspace='a0000000-0000-4000-8000-000000000001';jwt='test';release=null;fail=false;downloads=[];response=fixture();
  elements['ai-performance']={isConnected:true};elements['reply-report-status']={textContent:''};elements['reply-report-result']={innerHTML:''};
  for(const [k,v] of Object.entries({start:'2026-09-01',end:'2026-09-02',agent:'',rating:'all',reason:'all',language:'',query_type:'',outcome:'all'}))elements['reply-report-'+k]={value:v,innerHTML:'',insertAdjacentHTML(){}};
});
test('UTC date range is inclusive in the UI and exclusive on the server',()=>{
  const filter=reportFilters({start:'2026-09-01',end:'2026-09-02',agent:'',rating:'all',reason:'all'});
  expect(filter.end).toBe('2026-09-03T00:00:00.000Z');
  expect(()=>reportFilters({start:'2026-02-30',end:'2026-03-05'})).toThrow();
  expect(()=>reportFilters({start:'2026-10-01',end:'2026-09-02'})).toThrow();
});
test('renders honest denominators, explicit missing data and escaped agent names',()=>{
  const html=renderPerformanceData(fixture(),workspace);
  expect(html).toContain('50.0%');expect(html).toContain('33.3%');expect(html).toContain('2.0 min');
  expect(html).toContain('1 with usage tracking unavailable');expect(html).toContain('not active work or time saved');
  expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');
  const no=fixture();no.summary={...metrics,generated:0,tracked:0,rated:0,used:0,median_seconds:null};
  expect(renderPerformanceData(no,workspace)).toContain('No suggestions match');
});
test('CSV guards spreadsheet formulas and preserves missing cost and usage values',()=>{
  for(const text of ['=formula','  +formula','\t=bad','\rword','@bad','-bad'])expect(safeReportCell(text).startsWith("'")).toBe(true);
  const f=fixture();f.details[0].reply_context=null;f.details[0].generation_cost_micro=null;
  const row=reportDetailRows(f,workspace)[0];expect(row).toContain('Unavailable');expect(row.at(-1)).toContain('#/w/');
  expect(reportSummaryRows(f)[0][0]).toBe('Overall');
});
test('exports exactly the applied report and requires applying edited filters',async()=>{
  await loadPerformance();await exportPerformance();expect(downloads.length).toBe(1);
  expect(downloads[0][1][0]).toEqual(reportSummaryRows(response)[0].map(safeReportCell));
  elements['reply-report-reason'].value='wrong_match';await exportPerformance(true);expect(downloads.length).toBe(1);
  expect(elements['reply-report-status'].textContent).toContain('Apply filters');
});
test('drops late report and export results across workspace changes',async()=>{
  release=true;let pending=loadPerformance();workspace='other';release();await pending;release=null;
  expect(elements['reply-report-result'].innerHTML).toBe('');
  workspace='a0000000-0000-4000-8000-000000000001';await loadPerformance();release=true;
  pending=exportPerformance(true);jwt='other-user';release();await pending;expect(downloads.length).toBe(0);
});
test('invalidates in-flight report results when filters change and handles errors',async()=>{
  release=true;const pending=loadPerformance();elements['reply-report-rating'].value='helpful';release();await pending;release=null;
  expect(elements['reply-report-result'].innerHTML).toBe('');expect(elements['reply-report-status'].textContent).toContain('Filters changed');
  fail=true;await loadPerformance();expect(elements['reply-report-status'].textContent).toContain('couldn’t be loaded');
});
test('outcome and language breakdowns appear in the screen and exports',()=>{
  const data=fixture();data.summary.substantial=1;data.summary.rejected=1;
  data.languages=[{...metrics,reply_language:'Spanish',substantial:1,rejected:1}];
  data.queryTypes=[{...metrics,query_type:'payments',substantial:1,rejected:1}];
  Object.assign(data.details[0],{sent_change_ratio:0.5,reply_language:'Spanish',query_type:'payments'});
  const html=renderPerformanceData(data,workspace);
  expect(html).toContain('1 accepted with substantial changes');expect(html).toContain('not rejection');
  expect(html).toContain('Spanish');expect(html).toContain('payments');
  expect(reportSummaryRows(data).some(r=>r[0]==='Requested language'&&r[1]==='Spanish')).toBe(true);
  expect(reportDetailRows(data,workspace)[0]).toContain('Accepted · substantial change');
});
