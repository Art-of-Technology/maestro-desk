import { test, expect, mock, beforeEach } from 'bun:test';
const actions = {}, changes = {}, stored = new Map();
let identity = 0;
let missing = false, storageFails = false, writeFails = false, workspace = 'test-brand', navigated = null, keydown;
const session = { userId: 'agent-1', isAdmin: false, permissions: {} };
const host = { firstElementChild: null, _html: '', get innerHTML() { return this._html; }, set innerHTML(value) { this._html = value; this.firstElementChild = value ? {} : null; }, querySelector(selector) { return selector === '[data-guide-ready]' && this._html.includes('data-guide-ready') ? {} : null; } };
const first = { focus() { document.activeElement = this; }, getClientRects: () => [1] };
const last = { ...first };
const card = { style: {}, focus() { document.activeElement = this; }, contains: el => [first,last].includes(el), querySelectorAll: () => [first,last], getBoundingClientRect: () => ({width:380,height:190}) };
const target = { scrollIntoView() {}, getBoundingClientRect: () => ({left:220,top:60,bottom:90,width:200,height:30}) };
const spotlight = { style: {} };
globalThis.window = globalThis;
globalThis.escHtml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
globalThis.requestAnimationFrame = fn => fn();
globalThis.localStorage = { getItem(key) { if(storageFails) throw Error('blocked'); return stored.get(key) ?? null; }, setItem(key,value) { if(storageFails || writeFails) throw Error('blocked'); stored.set(key,value); } };
globalThis.document = { activeElement:null, getElementById: id => id === 'guide-container' ? host : null,
 querySelector: selector => selector.startsWith('[data-guide=') ? missing ? null : target : selector === '.guide-spotlight' ? spotlight : selector.includes('.guide-card') ? card : null,
 addEventListener(type,handler) { if(type === 'keydown') keydown=handler; } };
mock.module('../web/js/core/state.js',()=>({CURRENT_PAGE:'dashboard',SESSION:session}));
mock.module('../web/js/core/api-client.js',()=>({getWorkspaceId:()=>workspace}));
mock.module('../web/js/core/permissions.js',()=>({can:key=>session.permissions[key] === true,canViewTickets:()=>session.permissions['tickets.view_all'] === true || session.permissions['tickets.view_assigned'] === true}));
mock.module('../web/js/core/event-delegation.js',()=>({registerActions:map=>Object.assign(actions,map),registerChangeActions:map=>Object.assign(changes,map)}));
const { GUIDE_STEPS, GUIDE_MODULES, GUIDE_VERSION } = await import('../web/js/guides/config.js');
const { initGuides, maybeStartGuides, guidePageRendered, closeGuides } = await import('../web/js/guides/index.js');
const key = () => `respovia_guides:${workspace}:${session.userId}`;
const progress = () => JSON.parse(stored.get(key()) ?? 'null');
function grant(...keys) { for(const key of keys) session.permissions[key]=true; }
function module(id) { actions['guides.module']({module:id}); renderPage(); }
function renderPage() { const resume=progress()?.resume; const step=GUIDE_STEPS.find(s=>s.id===resume?.stepId); if(step) guidePageRendered(step.page); }
function next() { actions['guides.next'](); renderPage(); }
function finishSteps() { for(let i=0;i<30 && !host.innerHTML.includes('PRACTICE CHECKLIST');i++) next(); expect(host.innerHTML).toContain('PRACTICE CHECKLIST'); }
beforeEach(()=>{
 closeGuides(false); stored.clear(); missing=false; storageFails=false; writeFails=false; workspace='test-brand'; session.userId=`agent-${++identity}`; session.isAdmin=false; session.permissions={}; navigated=null;
 initGuides(page=>{navigated=page;});
});

test('exit saves the exact resume point without marking a step or practice complete',()=>{
 maybeStartGuides(); expect(host.innerHTML).toContain('See what needs attention');
 keydown({key:'Escape',preventDefault(){}});
 expect(host.innerHTML).toBe(''); expect(progress().viewed).toEqual([]); expect(progress().practiced).toEqual({});
 expect(progress().resume.stepId).toBe('dashboard');
 actions['guides.open'](); expect(host.innerHTML).toContain('Resume where you left off'); actions['guides.resume']();
 expect(host.innerHTML).toContain('See what needs attention');
});

test('full onboarding starts once, advances modules and keeps practice separate',()=>{
 grant('tickets.view_assigned'); maybeStartGuides(); next(); expect(navigated).toBe('tickets');
 expect(progress().viewed).toEqual(['dashboard']); finishSteps();
 expect(progress().practiced).toEqual({}); expect(host.innerHTML).toContain('Expected result:');
 actions['guides.continue'](); renderPage(); expect(host.innerHTML).toContain('See who is available');
 expect(progress().resume.full).toBe(true); closeGuides(); maybeStartGuides(); expect(host.innerHTML).toBe('');
});

test('saved custom-role grants control modules and deny direct stale entry',()=>{
 grant('tickets.view_assigned','tickets.create','tickets.attach','customers.view','customers.contact_primary');
 actions['guides.open'](); expect(host.innerHTML).toContain('Tickets, drafts and attachments'); expect(host.innerHTML).not.toContain('Reply, send and set status'); expect(host.innerHTML).not.toContain('Brand administration');
 module('administration'); expect(navigated).toBe(null);
 module('customers'); finishSteps(); expect(host.innerHTML).toContain('Review available email controls');
});

test('protected admin flag is required for role permissions even with delegated administration',()=>{
 grant('admin.agents','admin.settings'); module('administration'); expect(host.innerHTML).toContain('Invite and manage agents');
 expect(host.innerHTML).not.toContain('Tailor role permissions');
 session.isAdmin=true; module('administration'); expect(host.innerHTML).toContain('Review brand configuration'); next(); expect(host.innerHTML).toContain('Tailor role permissions');
});

test('practice needs every permitted step viewed and every check explicitly confirmed',()=>{
 module('preferences'); finishSteps(); actions['guides.confirm'](); expect(progress().practiced).toEqual({});
 changes['guides.check']({item:'notifications'},{checked:true}); expect(progress().practiced).toEqual({});
 actions['guides.confirm'](); expect(progress().practiced.preferences).toBeDefined(); expect(host.innerHTML).toContain('Practice confirmed by you');
 changes['guides.check']({item:'notifications'},{checked:false}); expect(progress().practiced.preferences).toBeUndefined();
});

test('missing targets stay visible and skipping does not certify viewing',()=>{
 missing=true; module('preferences'); expect(host.innerHTML).toContain('This area is not available'); expect(host.innerHTML).toContain('Skip →');
 finishSteps(); changes['guides.check']({item:'notifications'},{checked:true}); actions['guides.confirm']();
 expect(progress().viewed).toEqual([]); expect(progress().practiced).toEqual({});
});

test('revoked grants cannot be counted or resumed as viewed',()=>{
 grant('tickets.view_all','tickets.reply'); module('replies'); session.permissions['tickets.reply']=false; next();
 expect(host.innerHTML).toContain('Learn Respovia'); expect(progress().viewed).toEqual([]);
 actions['guides.resume'](); expect(host.innerHTML).toContain('Learn Respovia');
});

test('permission additions require fresh viewing and practice confirmation',()=>{
 grant('customers.view'); module('customers'); finishSteps(); changes['guides.check']({item:'profile'},{checked:true}); actions['guides.confirm']();
 actions['guides.open'](); expect(host.innerHTML).toContain('1/1 steps viewed · Practice confirmed by you');
 grant('customers.contact_add'); actions['guides.open'](); expect(host.innerHTML).toContain('1/2 steps viewed · Practice not confirmed');
});

test('changing workspace or user closes the old overlay without cross-account writes',()=>{
 module('preferences'); const originalKey=key(), original=stored.get(key()); workspace='other-brand'; next(); expect(host.innerHTML).toBe(''); expect(stored.get(originalKey)).toBe(original); expect(stored.has(key())).toBe(false);
 module('preferences'); const secondKey=key(), second=stored.get(key()); session.userId='other-agent'; guidePageRendered('settings'); expect(host.innerHTML).toBe(''); expect(stored.get(secondKey)).toBe(second); expect(stored.has(key())).toBe(false);
});

test('malformed, old and invalid resume data cannot mark completion',()=>{
 for(const value of ['broken',GUIDE_VERSION,JSON.stringify({version:GUIDE_VERSION,viewed:[],checked:[],practiced:{},resume:{moduleId:'missing'},started:true})]) {
  stored.set(key(),value); actions['guides.open'](); expect(host.innerHTML).not.toContain('Practice confirmed by you'); expect(host.innerHTML).not.toContain('Resume where you left off');
 }
});

test('blocked local storage still permits guides and warns about session-only progress',()=>{
 storageFails=true; actions['guides.open'](); expect(host.innerHTML).toContain('Browser storage is unavailable');
 actions['guides.module']({module:'preferences'}); guidePageRendered('settings'); expect(host.innerHTML).toContain('Choose notification preferences');
 next(); expect(host.innerHTML).toContain('PRACTICE CHECKLIST'); closeGuides(); actions['guides.open'](); expect(host.innerHTML).toContain('Resume where you left off');
});

test('keyboard focus wraps, Escape exits and typing arrows does not complete steps',()=>{
 module('preferences'); let prevented=false; keydown({key:'Tab',shiftKey:true,preventDefault(){prevented=true;}}); expect(prevented).toBe(true); expect(document.activeElement).toBe(last);
 keydown({key:'ArrowRight'}); expect(progress().viewed).toEqual([]);
 keydown({key:'Escape',preventDefault(){}}); expect(host.innerHTML).toBe('');
});


test('a write failure preserves newer progress even when old stored data can be read',()=>{
 module('preferences'); writeFails=true; next();
 expect(host.innerHTML).toContain('PRACTICE CHECKLIST'); expect(host.innerHTML).toContain('Browser storage is unavailable');
 closeGuides(); actions['guides.open'](); actions['guides.resume']();
 expect(host.innerHTML).toContain('PRACTICE CHECKLIST');
 changes['guides.check']({item:'notifications'},{checked:true}); writeFails=false;
 actions['guides.confirm'](); expect(progress().viewed).toContain('preferences'); expect(progress().practiced.preferences).toBeDefined();
});
