// Run separately: module mocks must not affect the API suite or render smokes.
import { test, expect, mock } from 'bun:test';
const articles = [],
  actions = {}, inputs = {};
let jwt = 'session',
  workspace = 'brand-a',
  confirm,
  posts = 0,
  fail = false,
  release;
let postBody, patchCalls = [], patchFail = false, patchRelease, modalLabel;
const session = { name: 'Test' };
let remoteFilters=[];
const syncTick=()=>new Promise(resolve=>setTimeout(resolve,0));
globalThis.localStorage = { getItem: () => null };
globalThis.window = { isAdmin: () => true, escHtml: String, escAttr: String };
globalThis.alert = () => {};
globalThis.document = {
  getElementById: (id) => ({
    value: {
      'kb-title': 'Withdrawal policy',
      'kb-cat': 'Withdrawals',
      'kb-body': 'Allow 24 hours after approval.',
    }[id],
  }),
};
mock.module('../web/js/core/data.js', () => ({ KB_ARTICLES: articles }));
mock.module('../web/js/core/state.js', () => ({
  CURRENT_PAGE: 'kb',
  KB_SELECTED: null,
  SESSION: session,
  setKbSelected() {},
}));
mock.module('../web/js/core/router.js', () => ({ renderPage() {} }));
mock.module('../web/js/ai/page.js', () => ({ renderMarkdown: String }));
mock.module('../web/js/core/event-delegation.js', () => ({
  registerActions: (a) => Object.assign(actions, a),
  registerInputActions: a => Object.assign(inputs, a),
}));
mock.module('../web/js/core/presence.js', () => ({ startPresence() {} }));
mock.module('../web/js/core/modal.js', () => ({
  showModal: (_t, _b, cb, label) => {
    confirm = cb;
    modalLabel = label;
  },
  closeModal() {},
}));
mock.module('../web/js/kb/sources.js', () => ({}));
mock.module('../web/js/kb/quality.js', () => ({}));
mock.module('../web/js/core/api-client.js', () => ({
  apiGet:async ()=>({items:structuredClone(remoteFilters)}),
  getJwt: () => jwt,
  getWorkspaceId: () => workspace,
  async apiPatch(path, body) {
    if(path.includes('kb-saved-filters')) { const item=remoteFilters.find(r=>path.endsWith('/'+r.id));Object.assign(item,body);return {item:{...item}}; }
    patchCalls.push({ path, body });
    if (patchFail) throw new Error('Offline');
    if (patchRelease) await new Promise(resolve => { patchRelease = resolve; });
    return { article: { status: 'published', updated_at: '2026-09-15T12:00:00Z' } };
  },
  apiDelete(path) {if(path.includes('kb-saved-filters'))remoteFilters=remoteFilters.filter(r=>!path.endsWith('/'+r.id));},
  apiPost: async (_path, body) => {
    if(_path.includes('kb-saved-filters')) {const item={...body,id:'saved-id'};remoteFilters.push(item);return {item};}
    postBody = body;
    posts++;
    if (fail) throw new Error('Offline');
    if (release)
      await new Promise((resolve) => {
        release = resolve;
      });
    return {
      article: {
        id: 'server-id',
        display_id: 'KB-server',
        title: 'Withdrawal policy',
        body: 'Allow 24 hours after approval.',
        status: body.status,
      },
    };
  },
}));
const { renderKB } = await import('../web/js/kb/index.js');
test('first live article persists, failures do not fake success, and late responses stay in their workspace', async () => {
  actions['kb.new']();
  expect(modalLabel).toBe('Save draft');
  await confirm();
  expect(postBody.status).toBe('draft');
  expect(articles[0].status).toBe('draft');
  expect(posts).toBe(1);
  expect(articles[0]._uuid).toBe('server-id');
  articles.length = 0;
  fail = true;
  actions['kb.new']();
  await confirm();
  expect(articles).toHaveLength(0);
  fail = false;
  await confirm();
  expect(articles).toHaveLength(1);
  articles.length = 0;
  release = true;
  actions['kb.new']();
  const saving = confirm();
  const before = posts;
  await confirm();
  expect(posts).toBe(before);
  workspace = 'brand-b';
  release();
  await saving;
  expect(articles).toHaveLength(0);
  release = null;
  jwt = null;
  workspace = null;
  actions['kb.new']();
  await confirm();
  expect(posts).toBe(before);
  expect(articles[0].id).toBe('KB-001');
});

test('matching-filter indicator follows actual criteria, all duplicate matches and saved-filter changes',async()=>{
  const originalGet=document.getElementById,originalQuery=document.querySelector;
  const originalJwt=jwt,originalWorkspace=workspace;
  const name={value:'Renamed match',focus(){}},message={textContent:'',focus(){}};
  document.getElementById=id=>id==='kb-filter-name'?name:message;document.querySelector=()=>null;
  jwt='match-session';workspace='match-brand';session.userId='match-agent';
  const filters={category:'Website',market:'en',status:'draft',query:'policy'};
  remoteFilters=[{id:'alpha',name:'Alpha',filters,is_pinned:true},{id:'beta',name:'Beta',filters,is_pinned:true},
    {id:'gamma',name:'Gamma',filters:{...filters,status:'published'},is_pinned:true}];
  const indicator=()=>renderKB().match(/id="kb-filter-match" role="status">([^<]*)/)[1];
  try {
    actions['kb.setCat']({cat:'Website'});actions['kb.setStatus']({status:'draft'});
    inputs['kb.setMarket']({}, {value:'en'});inputs['kb.setQuery']({}, {value:' POLICY '});
    renderKB();await syncTick();
    expect(indicator()).toBe('Matches saved filters: “Alpha”, “Beta”');
    expect(renderKB()).toContain('class="btn btn-sm btn-solid" id="kb-pinned-alpha"');
    expect(renderKB()).toContain('class="btn btn-sm btn-solid" id="kb-pinned-beta"');
    expect(renderKB()).toContain('class="btn btn-sm" id="kb-pinned-gamma"');
    expect(renderKB()).toContain('Apply saved filter Alpha. Matches current view.');
    inputs['kb.pickSaved']({}, {value:'gamma'});
    expect(indicator()).toBe('Matches saved filters: “Alpha”, “Beta”');
    for(const [change,restore] of [
      [()=>actions['kb.setCat']({cat:'Games'}),()=>actions['kb.setCat']({cat:'Website'})],
      [()=>inputs['kb.setMarket']({}, {value:'es-mx'}),()=>inputs['kb.setMarket']({}, {value:'en'})],
      [()=>actions['kb.setStatus']({status:'archived'}),()=>actions['kb.setStatus']({status:'draft'})],
      [()=>inputs['kb.setQuery']({}, {value:'different'}),()=>inputs['kb.setQuery']({}, {value:'policy'})],
    ]) {
      change();expect(indicator()).toBe('No saved filter matches this view.');
      expect(renderKB()).not.toContain('class="btn btn-sm btn-solid" id="kb-pinned-');
      restore();expect(indicator()).toBe('Matches saved filters: “Alpha”, “Beta”');
    }
    inputs['kb.pickSaved']({}, {value:'alpha'});await actions['kb.pinFilter']();
    expect(indicator()).toBe('Matches saved filters: “Alpha”, “Beta”');
    expect(renderKB()).not.toContain('id="kb-pinned-alpha"');
    actions['kb.renameFilter']();await confirm();expect(indicator()).toBe('Matches saved filters: “Renamed match”, “Beta”');
    actions['kb.deleteFilter']();await confirm();expect(indicator()).toBe('Matches saved filter: “Beta”');
    remoteFilters=[];await actions['kb.refreshFilters']();expect(indicator()).toBe('No saved filter matches this view.');
    session.userId='different-agent';expect(renderKB()).not.toContain('id="kb-filter-match"');await syncTick();
  } finally {
    actions['kb.setCat']({cat:'all'});actions['kb.setStatus']({status:'all'});
    inputs['kb.setMarket']({}, {value:'all'});inputs['kb.setQuery']({}, {value:''});
    jwt=originalJwt;workspace=originalWorkspace;
    delete session.userId;document.getElementById=originalGet;document.querySelector=originalQuery;
  }
});

test('bulk UI selects only matching drafts, clears filters, guards confirmation and retries failures', async () => {
  const originalGetElementById = document.getElementById;
  const originalQuerySelector = document.querySelector;
  const originalIsAdmin = window.isAdmin;
  try {
    jwt = 'session'; workspace = 'brand-a'; patchCalls = []; patchRelease = null; patchFail = false;
    const progress = { isConnected: true, textContent: '', focus() {} };
    document.getElementById = () => progress;
    document.querySelector = () => null;
    articles.splice(0, articles.length,
      { id: 'KB-a', _uuid: 'a', title: 'A', body: 'Link', category: 'Games · en-ca', status: 'draft' },
      { id: 'KB-b', _uuid: 'b', title: 'B', body: 'Link', category: 'Website · en-ca', status: 'draft' },
      { id: 'KB-c', _uuid: 'c', title: 'C', body: 'Link', category: 'Games · pt-br', status: 'draft' },
      { id: 'KB-d', _uuid: 'd', title: 'D', body: 'Link', category: 'Games · en-ca', status: 'published' });
    actions['kb.setStatus']({ status: 'all' });
    renderKB();
    actions['kb.selectMatching']();
    expect(renderKB()).toContain('3 selected');
    actions['kb.setCat']({ cat: 'Games' });
    inputs['kb.setMarket']({}, {value:'en-ca'});
    expect(renderKB()).not.toContain('kb-bulk-bar');
    actions['kb.selectMatching']();
    actions['kb.publishSelected']();
    expect(modalLabel).toBe('Publish 1 article');
    workspace = 'other';
    await confirm();
    expect(patchCalls).toHaveLength(0);
    workspace = 'brand-a';
    actions['kb.publishSelected']();
    const button = { disabled: false, textContent: '' };
    document.querySelector = () => { throw new Error('Unexpected DOM failure'); };
    await confirm();
    expect(patchCalls).toHaveLength(0);
    document.querySelector = () => button;
    patchFail = true;
    await confirm();
    expect(articles[0].status).toBe('draft');
    expect(renderKB()).toContain('1 selected');
    patchFail = false; patchRelease = true;
    actions['kb.publishSelected']();
    const callback = confirm;
    const pending = callback();
    await callback();
    expect(patchCalls).toHaveLength(2);
    patchRelease(); await pending; patchRelease = null;
    expect(articles[0].status).toBe('published');
    expect(articles[1].status).toBe('draft');
    expect(articles[2].status).toBe('draft');
    expect(renderKB()).toContain('0 selected');
    actions['kb.setCat']({ cat: 'all' });
    window.isAdmin = () => false;
    renderKB();
    actions['kb.selectMatching']();
    expect(renderKB()).not.toContain('kb.publishSelected');
    const previousConfirm = confirm;
    actions['kb.publishSelected']();
    expect(confirm).toBe(previousConfirm);
    window.isAdmin = () => true;
  } finally {
    inputs['kb.setMarket']({}, {value:'all'});
    document.getElementById = originalGetElementById;
    document.querySelector = originalQuerySelector;
    window.isAdmin = originalIsAdmin;
    actions['kb.setCat']({ cat: 'all' });
  }
});

test('compact list paginates, keeps selection across pages and resets pages for filters',()=>{
  const originalGet=document.getElementById, originalQuery=document.querySelector;
  jwt='session';workspace='pagination-test';document.querySelector=()=>null;
  document.getElementById=()=>({focus(){}});
  actions['kb.setCat']({cat:'all'});actions['kb.setStatus']({status:'all'});
  articles.splice(0,articles.length,...Array.from({length:101},(_,i)=>({id:`KB-${i}`, _uuid:`id-${i}`,title:`Policy ${i}`,body:'Source URL: https://example.test\n\nUseful policy content.',category:i%2?'Website · es-mx':'Website · en',status:'draft'})));
  let html=renderKB();expect((html.match(/class="kb-list-row"/g)||[]).length).toBe(50);
  expect(html).toContain('Entries 1–50 of 101');expect(html).not.toContain('Source URL:');
  expect(html).toContain('data-cat="Website"');expect(html).not.toContain('data-cat="Website · en"');
  expect(html).not.toContain('kb-bulk-bar');
  actions['kb.selectDraft']({uuid:'id-0'},{checked:true});
  actions['kb.page']({page:'1'});html=renderKB();
  expect(html).toContain('Entries 51–100 of 101');expect(html).toContain('1 selected across all pages');
  actions['kb.setStatus']({status:'draft'});html=renderKB();expect(html).toContain('Entries 1–50 of 101');
  actions['kb.selectMatching']();expect(renderKB()).toContain('101 selected across all pages');
  inputs['kb.setMarket']({}, {value:'es-mx'});html=renderKB();expect(html).toContain('50 of 101 articles');expect(html).toContain('0 selected');
  window.isAdmin=()=>false;expect(renderKB()).not.toContain('kb-bulk-bar');window.isAdmin=()=>true;
  inputs['kb.setMarket']({}, {value:'all'});actions['kb.setStatus']({status:'all'});
  document.getElementById=originalGet;document.querySelector=originalQuery;
});

test('review filters and publishing preserve drafts on failure and ignore late workspace responses', async () => {
  jwt = 'session'; workspace = 'brand-a';
  articles.splice(0, articles.length,
    { id: 'KB-draft', _uuid: 'draft-uuid', title: 'Review me', body: 'Policy', category: 'Help', status: 'draft', author: 'Jodi' },
    { id: 'KB-live', _uuid: 'live-uuid', title: 'Live policy', body: 'Policy', category: 'Help', status: 'published' },
    { id: 'KB-old', _uuid: 'old-uuid', title: 'Old policy', body: 'Policy', category: 'Help', status: 'archived' });
  expect(renderKB()).toContain('Awaiting review');
  actions['kb.setStatus']({ status: 'draft' });
  expect(renderKB()).toContain('Review me');
  expect(renderKB()).not.toContain('Live policy');
  actions['kb.setStatus']({ status: 'published' });
  expect(renderKB()).toContain('Live policy');
  expect(renderKB()).not.toContain('Review me');
  actions['kb.setStatus']({ status: 'all' });
  patchFail = true;
  actions['kb.publish']({ id: 'KB-draft' });
  expect(modalLabel).toBe('Publish article');
  await confirm();
  expect(articles[0].status).toBe('draft');
  patchFail = false;
  patchRelease = true;
  const pending = confirm();
  const count = patchCalls.length;
  await confirm();
  expect(patchCalls).toHaveLength(count);
  workspace = 'brand-b'; patchRelease(); await pending;
  expect(articles[0].status).toBe('draft');
  workspace = 'brand-a'; patchRelease = null;
  actions['kb.publish']({ id: 'KB-draft' });
  await confirm();
  expect(patchCalls.at(-1)).toEqual({ path: '/api/v1/kb-articles/draft-uuid', body: { status: 'published' } });
  expect(articles[0].status).toBe('published');
  expect(articles[0].author).toBe('Jodi');
  actions['kb.edit']({ id: 'KB-draft' });
  await confirm();
  expect(articles[0].updated).toBe('2026-09-15T12:00:00Z');
  const prior = patchCalls.length;
  actions['kb.publish']({ id: 'KB-live' });
  expect(patchCalls).toHaveLength(prior);
});

test('personal saved filter UI restores criteria and clears cross-page selection, with stale-session guards',async()=>{
  const originalStorage=globalThis.localStorage,originalGet=document.getElementById,originalQuery=document.querySelector;
  const values=new Map(),error={textContent:''},name={value:'My review',focus(){}},status={textContent:''};
  globalThis.localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
  document.getElementById=id=>id==='kb-filter-name'?name:id==='kb-filter-error'?error:status;
  status.focus=()=>{};document.querySelector=()=>null;
  jwt='saved-session';workspace='saved-brand';session.userId='saved-agent';
  try {
    actions['kb.setCat']({cat:'Website'});actions['kb.setStatus']({status:'draft'});
    inputs['kb.setMarket']({}, {value:'en'});
    articles.splice(0,articles.length,...Array.from({length:60},(_,i)=>({id:'KB-'+i,_uuid:'article-'+i,title:'Policy '+i,body:'Text',category:'Website · en',status:'draft'})));
    renderKB();await syncTick();expect(renderKB()).toContain('Personal · synced across devices');
    actions['kb.saveFilter']();await confirm();
    const saved=remoteFilters[0];
    expect(saved.filters).toEqual({category:'Website',market:'en',status:'draft',query:''});
    actions['kb.selectMatching']();actions['kb.page']({page:'1'});
    expect(renderKB()).toContain('60 selected');expect(renderKB()).toContain('Entries 51–60');
    inputs['kb.pickSaved']({}, {value:saved.id});actions['kb.applySaved']();
    expect(renderKB()).toContain('0 selected');expect(renderKB()).toContain('Entries 1–50');
    await actions['kb.pinFilter']();
    expect(remoteFilters[0].is_pinned).toBe(true);expect(renderKB()).toContain('aria-label="Pinned filters"');
    actions['kb.selectMatching']();actions['kb.page']({page:'1'});
    expect(renderKB()).toContain('60 selected');
    // A pinned shortcut restores criteria directly, without first selecting the dropdown.
    inputs['kb.pickSaved']({}, {value:''});actions['kb.applyPinned']({id:saved.id});
    expect(renderKB()).toContain('0 selected');expect(renderKB()).toContain('Entries 1–50');
    actions['kb.setStatus']({status:'published'});inputs['kb.setMarket']({}, {value:'es-mx'});
    actions['kb.applyPinned']({id:saved.id});expect(renderKB()).toContain('value="en" selected');expect(renderKB()).toContain('60 of 60 articles');
    await actions['kb.pinFilter']();
    expect(remoteFilters).toHaveLength(1);expect(renderKB()).not.toContain('aria-label="Pinned filters"');
    expect(renderKB()).toContain('>My review</option>');
    actions['kb.renameFilter']();name.value='Renamed';await confirm();
    expect(remoteFilters[0].name).toBe('Renamed');
    actions['kb.renameFilter']();session.userId='another-agent';name.value='Wrong agent';await confirm();
    expect(error.textContent).toContain('session changed');expect(remoteFilters[0].name).toBe('Renamed');
    expect(renderKB()).not.toContain('>Renamed</option>');
    session.userId='saved-agent';renderKB();await syncTick();inputs['kb.pickSaved']({}, {value:saved.id});
    // A no-longer-loaded category/market remains visible instead of silently showing All.
    const missing={...saved,filters:{category:'Retired category',market:'es-zz',status:'draft',query:'example'}};
    remoteFilters=[missing];await actions['kb.refreshFilters']();inputs['kb.pickSaved']({}, {value:saved.id});actions['kb.applySaved']();
    expect(renderKB()).toContain('data-cat="Retired category"');expect(renderKB()).toContain('value="es-zz" selected');
    actions['kb.deleteFilter']();await confirm();expect(remoteFilters).toEqual([]);
  } finally {
    delete session.userId;globalThis.localStorage=originalStorage;document.getElementById=originalGet;document.querySelector=originalQuery;
  }
});
