import { test, expect, mock } from 'bun:test';
const handlers={}, attributes={}, stored=new Map([['sidebar_collapsed','0']]);
let collapsed=false, resized, focused=false;
const media={matches:false,addEventListener(_event,fn){resized=fn;}};
const bar={classList:{toggle(_name,value){collapsed=value;},contains(){return collapsed;}}};
const button={setAttribute(k,v){attributes[k]=v;},focus(){focused=true;}};
globalThis.window={matchMedia:()=>media};
globalThis.localStorage={getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v)};
globalThis.document={querySelector:s=>s==='.sidebar'?bar:null,querySelectorAll:()=>[],getElementById:()=>button,
  addEventListener:(event,fn)=>{handlers[event]=fn;}};
mock.module('../web/js/core/event-delegation.js',()=>({registerActions(){}}));
const {toggleSidebar}=await import('../web/js/core/sidebar.js');

test('mobile collapse, expansion and navigation preserve the desktop preference',()=>{
  expect(collapsed).toBe(false);
  media.matches=true;resized();expect(collapsed).toBe(true);expect(attributes['aria-expanded']).toBe('false');
  toggleSidebar();expect(collapsed).toBe(false);expect(stored.get('sidebar_collapsed')).toBe('0');
  handlers.click({target:{closest:()=>({})}});expect(collapsed).toBe(true);
  toggleSidebar();
  handlers.keydown({key:'Escape',defaultPrevented:true,target:{closest:()=>bar}});expect(collapsed).toBe(false);
  handlers.keydown({key:'Escape',target:{closest:()=>null}});expect(collapsed).toBe(false);
  handlers.keydown({key:'Escape',target:{closest:()=>bar}});expect(collapsed).toBe(true);expect(focused).toBe(true);
  media.matches=false;resized();expect(collapsed).toBe(false);
  toggleSidebar();expect(stored.get('sidebar_collapsed')).toBe('1');
  media.matches=true;resized();toggleSidebar();expect(collapsed).toBe(false);
  media.matches=false;resized();expect(collapsed).toBe(true);expect(stored.get('sidebar_collapsed')).toBe('1');
});
