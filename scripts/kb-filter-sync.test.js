import {test,expect} from 'bun:test';
import {createFilterSync} from '../web/js/kb/filter-sync.js';
const filters={category:'Website',market:'en',status:'draft',query:'withdrawal'};
const local={id:'local',name:'Review',filters};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function setup(initial=[local]) {
  let scope='agent-a',rows=[],offline=false,blockGet=null,blockPost=null,cleanupFails=false;
  const receipts=new Map(),data=new Map([['a',JSON.stringify(initial)]]);
  const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>{if(cleanupFails)throw Error('quota');data.set(key,value);}};
  const api={
    async get(){if(blockGet)await blockGet;if(offline)throw Error('offline');return {items:structuredClone(rows)};},
    async post(path,body){
      if(offline)throw Error('offline');
      if(path.endsWith('/import')) {
        for(const item of body.items)if(!receipts.has(item.id)){receipts.set(item.id,JSON.stringify(item));rows.push({...item,id:'remote-'+item.id});}
        if(blockPost)await blockPost;
        return {transferred:body.items.filter(item=>receipts.get(item.id)===JSON.stringify(item)).map(item=>item.id)};
      }
      if(blockPost)await blockPost;
      const item={...body,id:'new'};rows.push(item);return {item};
    },
    async patch(path,body){if(offline)throw Error('offline');const item=rows.find(r=>path.endsWith('/'+r.id));Object.assign(item,body);return {item:{...item}};},
    async delete(path){if(offline)throw Error('offline');rows=rows.filter(r=>!path.endsWith('/'+r.id));},
  };
  const sync=createFilterSync({api,storage:()=>storage,currentScope:()=>scope,changed(){}});
  return {sync,data,storage,api,setScope:v=>scope=v,setOffline:v=>offline=v,setGet:v=>blockGet=v,setPost:v=>blockPost=v,setCleanup:v=>cleanupFails=v};
}
test('transfers browser filters and loads the same account from a second device',async()=>{
  const h=setup();h.sync.ensure('agent-a','a');await tick();
  expect(h.sync.state.phase).toBe('ready');expect(h.sync.state.items[0].filters).toEqual(filters);
  expect(JSON.parse(h.data.get('a'))).toEqual([]);
  const second=createFilterSync({api:h.api,storage:()=>({getItem:()=>null}),currentScope:()=> 'agent-a',changed(){}});
  second.ensure('agent-a','a');await tick();expect(second.state.items).toEqual(h.sync.state.items);
  await second.mutate('rename',{id:'remote-local',name:'Daily'});await h.sync.refresh();
  expect(h.sync.state.items[0].name).toBe('Daily');
});
test('failed cleanup and retries cannot resurrect a remotely deleted filter',async()=>{
  const h=setup();h.setCleanup(true);h.sync.ensure('agent-a','a');await tick();
  expect(h.sync.state.warning).toContain('kept');expect(h.sync.state.items).toHaveLength(1);
  await h.sync.mutate('delete',{id:'remote-local'});
  h.setCleanup(false);await h.sync.refresh();
  expect(h.sync.state.items).toEqual([]);expect(JSON.parse(h.data.get('a'))).toEqual([]);
});
test('a lost import response keeps browser filters and retry does not duplicate them',async()=>{
  const h=setup(),post=h.api.post;let loseResponse=true;
  h.api.post=async(...args)=>{const result=await post(...args);if(loseResponse)throw Error('response lost');return result;};
  h.sync.ensure('agent-a','a');await tick();
  expect(h.sync.state.items).toHaveLength(1);expect(JSON.parse(h.data.get('a'))).toEqual([local]);
  loseResponse=false;await h.sync.refresh();
  expect(h.sync.state.items).toHaveLength(1);expect(JSON.parse(h.data.get('a'))).toEqual([]);
});
test('offline loads preserve browser data and retry recovers without false success',async()=>{
  const h=setup();h.setOffline(true);h.sync.ensure('agent-a','a');await tick();
  expect(h.sync.state.phase).toBe('error');expect(JSON.parse(h.data.get('a'))).toEqual([local]);
  h.setOffline(false);await h.sync.refresh();h.setOffline(true);
  await expect(h.sync.mutate('rename',{id:'remote-local',name:'No'})).rejects.toThrow('offline');
  expect(h.sync.state.items[0].name).toBe('Review');expect(h.sync.state.phase).toBe('ready');
});
test('pin preference syncs to another device and failed unpin preserves the last saved state',async()=>{
  const h=setup();h.sync.ensure('agent-a','a');await tick();
  await h.sync.mutate('pin',{id:'remote-local',is_pinned:true});
  expect(h.sync.state.items[0]).toMatchObject({name:'Review',filters,is_pinned:true});
  const second=createFilterSync({api:h.api,storage:()=>({getItem:()=>null}),currentScope:()=> 'agent-a',changed(){}});
  second.ensure('agent-a','a');await tick();expect(second.state.items[0].is_pinned).toBe(true);
  h.setOffline(true);
  await expect(h.sync.mutate('pin',{id:'remote-local',is_pinned:false})).rejects.toThrow('offline');
  expect(h.sync.state.items[0].is_pinned).toBe(true);
  h.setOffline(false);await h.sync.mutate('pin',{id:'remote-local',is_pinned:false});await second.refresh();
  expect(second.state.items[0]).toMatchObject({name:'Review',filters,is_pinned:false});
});
test('scope changes discard delayed loads and never send an import in the new session',async()=>{
  const h=setup();let release;h.setGet(new Promise(resolve=>release=resolve));
  h.sync.ensure('agent-a','a');h.setScope('agent-b');h.sync.ensure('agent-b','b');release();await tick();
  expect(h.sync.state.scope).toBe('agent-b');expect(h.sync.state.items).toEqual([]);
  expect(JSON.parse(h.data.get('a'))).toEqual([local]);
});
test('scope changes during import retain local data and isolate late mutations',async()=>{
  const h=setup();let release;h.setPost(new Promise(resolve=>release=resolve));
  h.sync.ensure('agent-a','a');await tick();h.setScope('agent-b');release();await tick();
  expect(JSON.parse(h.data.get('a'))).toEqual([local]);
  h.setScope('agent-a');h.setPost(null);h.sync.ensure('agent-a','a');await tick();
  expect(h.sync.state.phase).toBe('ready');
  h.setPost(new Promise(resolve=>release=resolve));
  const pending=h.sync.mutate('save',{name:'New',filters});h.setScope('agent-b');h.sync.ensure('agent-b',null);release();
  expect(await pending).toBeNull();expect(h.sync.state.items).toEqual([]);
});
test('browser edits made during transfer are retained; damaged storage does not hide cloud filters',async()=>{
  const h=setup();let release;h.setPost(new Promise(resolve=>release=resolve));h.sync.ensure('agent-a','a');await tick();
  const changed={...local,name:'Changed in old tab'};h.data.set('a',JSON.stringify([changed]));release();await tick();
  expect(JSON.parse(h.data.get('a'))).toEqual([changed]);
  await h.sync.refresh();expect(JSON.parse(h.data.get('a'))).toEqual([changed]);
  h.data.set('a','broken');await h.sync.refresh();
  expect(h.sync.state.phase).toBe('ready');expect(h.sync.state.items).toHaveLength(1);expect(h.data.get('a')).toBe('broken');
});
