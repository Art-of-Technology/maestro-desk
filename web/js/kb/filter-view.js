// A delayed default must never replace an agent's explicit choice.
export function createDefaultView() {
  let scope, decided=false, touched=false;
  return {
    enter(next, explicitArticle=false) {
      const changed=scope!==next;
      if(changed) {scope=next;decided=false;touched=false;}
      if(explicitArticle)touched=true;
      return changed;
    },
    touch() {touched=true;},
    choose(items) {
      if(decided)return null;
      decided=true;
      return touched ? null : items.find(item=>item.is_default) || null;
    },
  };
}
export function activeFilterEntries(filters) {
  return [['category','Category'],['market','Market / language'],['status','Status'],['query','Search']]
    .filter(([key])=>key==='query' ? filters[key].trim() : filters[key]!=='all')
    .map(([key,label])=>({key,label:`${label}: ${filters[key]}`}));
}
