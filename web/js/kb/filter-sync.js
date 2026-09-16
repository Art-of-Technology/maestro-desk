import { readSavedFilters } from './saved-filters.js';

const ROOT = '/api/v1/kb-saved-filters';
// One active account at a time. Requests retain their scope; late responses
// cannot update another account's list or remove its browser filters.
export function createFilterSync({api, storage, currentScope, changed}) {
  let state = {scope:'', key:null, items:[], phase:'idle', error:'', warning:''};
  let generation = 0;
  const active = (scope, version) => {
    if (state.scope !== scope || version !== generation) return false;
    if (currentScope() === scope) return true;
    state = {...state,phase:'idle'};
    generation++;
    return false;
  };
  async function load() {
    const {scope,key} = state, version = ++generation;
    state = {...state, phase:'loading', error:'', warning:''};
    changed();
    try {
      let result = await api.get(ROOT);
      if (!active(scope,version)) return;
      let warning = '';
      try {
        const local = readSavedFilters(storage(),key);
        if (local.length) {
          const {transferred} = await api.post(ROOT + '/import', {items:local});
          if (!active(scope,version)) return;
          result = await api.get(ROOT);
          if (!active(scope,version)) return;
          // Only remove the exact entries acknowledged by the server. Another
          // old tab may have changed the browser data while import was pending.
          const remaining = readSavedFilters(storage(),key).filter(item =>
            !local.some(sent => transferred.includes(sent.id) && JSON.stringify(sent) === JSON.stringify(item)));
          storage().setItem(key,JSON.stringify(remaining));
          if (remaining.length) warning = 'Some browser filters changed after transfer and are still kept in this browser. Save them again with a new name to sync those changes.';
        }
      } catch {
        warning = 'Some browser filters could not be transferred. They are kept in this browser. Free space if you have 25 saved filters, then refresh to retry.';
        // Import may have committed despite a lost response or cleanup failure.
        result = await api.get(ROOT);
        if (!active(scope,version)) return;
      }
      state = {...state,items:result.items,phase:'ready',warning};
    } catch {
      if (!active(scope,version)) return;
      state = {...state,items:[],phase:'error',error:'Saved filters could not be loaded. Refresh to try again.'};
    }
    if (active(scope,version)) changed();
  }
  return {
    get state() { return state; },
    ensure(scope,key) {
      if (state.scope === scope) { if (key && state.phase === 'idle') void load(); return; }
      generation++;
      state = {scope,key,items:[],phase:'idle',error:'',warning:''};
      if (key) void load();
    },
    refresh() { if (state.key && !['loading','saving'].includes(state.phase)) return load(); },
    async mutate(action,{id,name,filters,is_pinned}) {
      if (!['save','rename','pin','delete'].includes(action)) throw Error('Unknown saved filter action.');
      const {scope} = state;
      if (scope !== currentScope() || state.phase !== 'ready') throw Error('Wait for saved filters to load, then try again.');
      const version = ++generation;
      state = {...state,phase:'saving'};
      changed();
      try {
        const result = action === 'save' ? await api.post(ROOT,{name,filters})
          : action === 'rename' ? await api.patch(ROOT+'/'+encodeURIComponent(id),{name})
          : action === 'pin' ? await api.patch(ROOT+'/'+encodeURIComponent(id),{is_pinned})
          : await api.delete(ROOT+'/'+encodeURIComponent(id));
        if (!active(scope,version)) return null;
        const items = action === 'save' ? [...state.items,result.item]
          : action === 'rename' || action === 'pin' ? state.items.map(item => item.id === id ? result.item : item)
          : state.items.filter(item => item.id !== id);
        state = {...state,items,phase:'ready'};
        changed();
        return action === 'delete' ? '' : result.item.id;
      } catch(error) {
        if (!active(scope,version)) return null;
        state = {...state,phase:'ready'};
        changed();
        throw error;
      }
    },
  };
}
