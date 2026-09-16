// Run separately because this suite mocks application modules.
import {test,expect,mock} from 'bun:test';
const actions={},changes={};let host,scope='a',requests=[],fail=false,release;
const item={id:'finding',article_id:'article',kind:'thin',display_id:'KB-1',title:'<Policy>',category:'Policy',detail:'Short article',detected_at:'2026-09-16T00:00:00Z',note:'',stale:false};
globalThis.window={isAdmin:()=>true,escHtml:s=>String(s).replaceAll('<','&lt;'),escAttr:String};
globalThis.document={getElementById:id=>id==='kb-quality-content'?host:{value:'Reviewed wording'}};
mock.module('../web/js/core/event-delegation.js',()=>({registerActions:map=>Object.assign(actions,map),registerChangeActions:map=>Object.assign(changes,map)}));
mock.module('../web/js/core/modal.js',()=>({showModal(){host={innerHTML:''};},closeModal(){host=null;}}));
mock.module('../web/js/core/router.js',()=>({renderPage(){}}));
mock.module('../web/js/core/state.js',()=>({setKbSelected(){}}));
mock.module('../web/js/core/api-client.js',()=>({getWorkspaceId:()=>scope,getJwt:()=>scope,
  async apiGet(path){requests.push(path);if(release)await new Promise(resolve=>{release=resolve;});return {items:[structuredClone(item)],hasMore:false};},
  async apiPost(path,body){requests.push({path,body});if(fail)throw Error('Try again');return path.endsWith('/scan')?{scanned:1,next:null}:{results:[],next:null};},
  async apiPatch(path,body){requests.push({path,body});if(fail)throw Error('Try again');return {ok:true};},
}));
await import('../web/js/kb/quality.js');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('quality queue escapes content, scans, filters, records notes and keeps errors visible',async()=>{
  actions['kbQuality.show']();await tick();expect(host.innerHTML).toContain('&lt;Policy>');
  await actions['kbQuality.scan']();expect(host.innerHTML).toContain('Scan complete');
  await changes['kbQuality.kind']({}, {value:'thin'});expect(requests.at(-1)).toContain('kind=thin');
  await actions['kbQuality.resolve']({id:'finding',state:'dismissed'});
  expect(requests.at(-2)).toEqual({path:'/api/v1/kb-quality/finding',body:{state:'dismissed',note:'Reviewed wording'}});
  fail=true;await actions['kbQuality.resolve']({id:'finding',state:'reviewed'});expect(host.innerHTML).toContain('Try again');fail=false;
});
test('late loads cannot render into a replacement dialog or another workspace',async()=>{
  release=true;actions['kbQuality.show']();await tick();const old=host;
  scope='b';host={innerHTML:'Different dialog'};release();release=null;await tick();
  expect(host.innerHTML).toBe('Different dialog');expect(old.innerHTML).toContain('Working');
  const count=requests.length;await actions['kbQuality.scan']();expect(requests).toHaveLength(count);
});
