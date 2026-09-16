import {test,expect} from 'bun:test';
import {filterStorageKey,readSavedFilters,changeSavedFilter} from '../web/js/kb/saved-filters.js';
const filters={category:'Website',market:'es-mx',status:'draft',query:'withdrawal'};
const memory=()=>{const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};};

test('saved filters persist exact criteria and isolate users and workspaces',()=>{
  const storage=memory(),key=filterStorageKey('brand-a','user-a');
  changeSavedFilter(storage,key,{action:'save',id:'one',name:' Mexico review ',filters});
  expect(readSavedFilters(storage,key)).toEqual([{id:'one',name:'Mexico review',filters}]);
  expect(readSavedFilters(storage,filterStorageKey('brand-b','user-a'))).toEqual([]);
  expect(readSavedFilters(storage,filterStorageKey('brand-a','user-b'))).toEqual([]);
  expect(filterStorageKey('brand-a',null)).toBeNull();
  expect(()=>changeSavedFilter(storage,null,{action:'save',id:'one',name:'x',filters})).toThrow('Sign in');
});
test('rename and delete preserve criteria and do not recreate stale entries',()=>{
  const storage=memory(),key='test';
  changeSavedFilter(storage,key,{action:'save',id:'one',name:'Review',filters});
  changeSavedFilter(storage,key,{action:'rename',id:'one',name:'Renamed'});
  expect(readSavedFilters(storage,key)[0]).toEqual({id:'one',name:'Renamed',filters});
  changeSavedFilter(storage,key,{action:'delete',id:'one'});expect(readSavedFilters(storage,key)).toEqual([]);
  expect(()=>changeSavedFilter(storage,key,{action:'rename',id:'one',name:'Gone'})).toThrow('no longer exists');
});
test('validation rejects empty and duplicate names, invalid criteria and excessive entries',()=>{
  const storage=memory(),key='test';
  expect(()=>changeSavedFilter(storage,key,{action:'save',id:'one',name:' ',filters})).toThrow('name');
  expect(()=>changeSavedFilter(storage,key,{action:'save',id:'one',name:'Name',filters:{...filters,status:'unknown'}})).toThrow('filters');
  changeSavedFilter(storage,key,{action:'save',id:'one',name:'Name',filters});
  expect(()=>changeSavedFilter(storage,key,{action:'save',id:'two',name:'NAME',filters})).toThrow('already');
  for(let i=1;i<25;i++)changeSavedFilter(storage,key,{action:'save',id:String(i),name:'Filter '+i,filters});
  expect(()=>changeSavedFilter(storage,key,{action:'save',id:'last',name:'Last',filters})).toThrow('25');
});
test('storage failures and corrupt data are reported without overwriting stored filters',()=>{
  const storage=memory(),key='test';
  storage.setItem(key,'broken');expect(()=>readSavedFilters(storage,key)).toThrow('damaged');
  expect(()=>changeSavedFilter(storage,key,{action:'save',id:'one',name:'Name',filters})).toThrow();
  expect(storage.getItem(key)).toBe('broken');
  const blocked={getItem:()=>null,setItem:()=>{throw Error('QuotaExceeded');}};
  expect(()=>changeSavedFilter(blocked,key,{action:'save',id:'one',name:'Name',filters})).toThrow('browser');
  storage.setItem(key,JSON.stringify([{id:'one',name:'Name',filters:{query:1}}]));
  expect(()=>readSavedFilters(storage,key)).toThrow('damaged');
});
