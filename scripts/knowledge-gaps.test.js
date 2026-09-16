import {expect,mock,test} from 'bun:test';
mock.module('../web/js/core/api-client.js',()=>({apiGet(){},apiPost(){},apiPatch(){},getWorkspaceId(){},getJwt(){}}));
mock.module('../web/js/core/event-delegation.js',()=>({registerActions(){},registerChangeActions(){}}));
mock.module('../web/js/core/modal.js',()=>({showModal(){},closeModal(){}}));
mock.module('../web/js/core/state.js',()=>({setKbSelected(){}}));
mock.module('../web/js/core/router.js',()=>({renderPage(){}}));
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
globalThis.window={escHtml:escape,escAttr:escape};
const {gapCards}=await import('../web/js/kb/gaps.js');
test('ticket evidence stays scoped, escaped and explicitly dated as scan evidence',()=>{
  const workspace='a0000000-0000-4000-8000-000000000001';
  const item={id:'a0000000-0000-4000-8000-000000000002',category:'Payments',brand:'<img>',market:'UK',state:'open',version:0,note:'<script>note',scanned_at:'2026-09-16',tickets:[{id:'a0000000-0000-4000-8000-000000000003',display_id:'T1',subject:'<script>subject',signal:'unanswered'}]};
  const html=gapCards([item],workspace);
  expect(html).toContain(workspace);expect(html).toContain('&lt;script>');expect(html).not.toContain('<script>');
  expect(html).toContain('Unanswered at scan');expect(html).toContain('Fewer than two');expect(html).toContain('noopener noreferrer');
});
