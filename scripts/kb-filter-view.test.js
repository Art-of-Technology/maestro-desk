import {test,expect} from 'bun:test';
import {createDefaultView,activeFilterEntries} from '../web/js/kb/filter-view.js';
const item={id:'one',is_default:true,filters:{category:'Website',market:'en',status:'draft',query:'refund'}};
test('default applies once per account and workspace, never on return or refresh',()=>{
  const view=createDefaultView();
  expect(view.enter('a')).toBe(true);
  expect(view.choose([item])).toBe(item);
  expect(view.enter('a')).toBe(false);
  expect(view.choose([{...item,id:'remote-change'}])).toBeNull();
  expect(view.enter('b')).toBe(true);
  expect(view.choose([item])).toBe(item);
});
test('typing and explicit article navigation win over delayed defaults',()=>{
  const view=createDefaultView();view.enter('a');view.touch();
  expect(view.choose([item])).toBeNull();
  view.enter('b',true);expect(view.choose([item])).toBeNull();
  view.enter('c');expect(view.choose([])).toBeNull();
  expect(view.choose([item])).toBeNull();
});
test('chips expose every effective criterion and omit cleared or blank criteria',()=>{
  expect(activeFilterEntries(item.filters).map(x=>x.key)).toEqual(['category','market','status','query']);
  expect(activeFilterEntries({category:'all',market:'all',status:'all',query:'  '})).toEqual([]);
  expect(activeFilterEntries({...item.filters,query:'<script>'})[3].label).toBe('Search: <script>');
});
