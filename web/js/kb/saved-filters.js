const MAX_FILTERS = 25;
const string = (value, max) => typeof value === 'string' && value.length <= max;
export function validFilters(value) {
  return value && string(value.category,200) && string(value.market,50) && string(value.query,500)
    && ['all','draft','published','archived'].includes(value.status);
}
export function filterStorageKey(workspace, user) {
  return workspace && user ? 'kb-filters:v1:' + JSON.stringify([workspace,user]) : null;
}
export function readSavedFilters(storage, key) {
  if (!key) return [];
  const raw = storage.getItem(key);
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw Error('Saved filters could not be read. Browser data may be damaged.'); }
  if (!Array.isArray(parsed) || parsed.length > MAX_FILTERS || parsed.some(item => !item
    || !string(item.id,100) || !item.id || !string(item.name,60) || !item.name.trim() || !validFilters(item.filters))
    || new Set(parsed.map(item=>item.id)).size !== parsed.length)
    throw Error('Saved filters could not be read. Browser data may be damaged.');
  return parsed;
}
export function changeSavedFilter(storage, key, {action,id,name,filters}) {
  if (!key) throw Error('Sign in to save personal filters.');
  const items = readSavedFilters(storage,key);
  if (action !== 'delete') {
    name = String(name || '').trim();
    if (!name || name.length > 60) throw Error('Enter a name of 1–60 characters.');
    if (items.some(item=>item.id!==id && item.name.toLowerCase()===name.toLowerCase()))
      throw Error('A saved filter already has that name. Choose another name.');
  }
  if (action === 'save') {
    if (!validFilters(filters)) throw Error('The current filters are too long to save. Shorten the search or category.');
    if (items.length >= MAX_FILTERS) throw Error('You can save up to 25 filters. Delete one before adding another.');
    if (!string(id,100) || !id || items.some(item=>item.id===id)) throw Error('Could not create this filter. Try again.');
    items.push({id,name,filters:{category:filters.category,market:filters.market,status:filters.status,query:filters.query}});
  } else {
    const index = items.findIndex(item=>item.id===id);
    if (index < 0) throw Error('This saved filter no longer exists. Reopen the list.');
    if (action === 'rename') items[index] = {...items[index],name};
    else if (action === 'delete') items.splice(index,1);
    else throw Error('Unknown saved filter action.');
  }
  try { storage.setItem(key,JSON.stringify(items)); }
  catch { throw Error('Could not save the change in this browser. Check browser storage and try again.'); }
  return items;
}
