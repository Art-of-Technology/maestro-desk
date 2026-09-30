import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'bun:test';

const source = readFileSync(new URL('../web/js/tickets/list.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
function fixture() {
  const state = { FILTER_INBOX:'all', FILTER_STATUS:'outstanding', FILTER_VIEW:'all', FILTER_CATEGORY:'all',
    FILTER_PRIORITY:'all', FILTER_AGENT:'all', FILTER_SENTIMENT:'all', FILTER_QUERY:'', SORT_COL:'id', SORT_DIR:1,
    VISIBLE_LIMIT:50, TICKET_SELECTED_IDS:new Set(['old']), SESSION:null, CUSTOMERS:[], SAVED_SEARCHES:[],
    TICKETS:[{id:'1',status:'open',channelId:'support',priority:'high'},
      {id:'2',status:'pending',channelId:'payments',priority:'high'},
      {id:'3',status:'open',channelId:'payments',priority:'normal'},
      {id:'4',status:'open',channelId:null,priority:'normal'},
      {id:'5',status:'resolved',channelId:'payments',priority:'high'}],
    isOutstanding:t=>!['resolved','closed'].includes(t.status), renderPage() {},
    registerInputActions() {},
  };
  for (const name of ['Category','Priority','Agent','Sentiment','Query']) state['setFilter'+name] = value => { state['FILTER_'+name.toUpperCase()] = value; };
  state.registerActions = actions => { state.actions=actions; };
  state.registerChangeActions = actions => { state.changes=actions; };
  runInNewContext(section('function currentFilterSnapshot()', 'async function saveCurrentSearch()')
    + section('function applySavedSearch(', 'function manageSavedSearches(')
    + section('function getFilteredTickets()', 'function groupTicketsBy(')
    + source.slice(source.indexOf('registerActions({')), state);
  return state;
}
test('inbox combines with priority/status and follows moved tickets', () => {
  const s=fixture(); s.changes['tickets.setFilter']({filter:'inbox'},{value:'payments'});
  expect(s.getFilteredTickets().map(t=>t.id)).toEqual(['2','3']); expect(s.TICKET_SELECTED_IDS.size).toBe(0);
  s.FILTER_PRIORITY='high'; expect(s.getFilteredTickets().map(t=>t.id)).toEqual(['2']);
  s.TICKETS[1].channelId='support'; expect(s.getFilteredTickets()).toHaveLength(0);
  s.FILTER_STATUS='history'; expect(s.getFilteredTickets().map(t=>t.id)).toEqual(['5']);
});
test('no-inbox selection and clearing use the same filter path', () => {
  const s=fixture(); s.changes['tickets.setFilter']({filter:'inbox'},{value:'none'});
  expect(s.getFilteredTickets().map(t=>t.id)).toEqual(['4']);
  s.actions['tickets.clearFilter']({filter:'inbox'}); expect(s.getFilteredTickets()).toHaveLength(4);
});
test('saved searches round-trip the inbox and old searches reset it', () => {
  const s=fixture(); s.FILTER_INBOX='payments'; s.FILTER_PRIORITY='high';
  s.SAVED_SEARCHES=[{id:'new',filters:s.currentFilterSnapshot()},{id:'old',filters:{}}];
  s.FILTER_INBOX='support'; s.applySavedSearch('new');
  expect(s.getFilteredTickets().map(t=>t.id)).toEqual(['2']);
  s.applySavedSearch('old'); expect(s.FILTER_INBOX).toBe('all'); expect(s.getFilteredTickets()).toHaveLength(4);
});
