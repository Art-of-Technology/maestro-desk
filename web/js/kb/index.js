// ─── Knowledge Base ──────────────────────────────────────────────────────────
// Article library page with category sidebar + search + sortable cards
// (featured first, then by updated date). The article view tracks per-id
// views and helpful-votes in localStorage (KB_VOTES / KB_USER_VOTES /
// KB_VIEWS) and renders the body through a tiny markdown subset shared
// with the AI assistant.
//
// Click/input handlers route through core/event-delegation.js. No
// external module reaches into kb's exports — `renderKB` is the only
// export consumed (app.js's router).
//
// External reaches (interim, via window): isAdmin, escAttr, escHtml — all
// still in app.js.

import { KB_ARTICLES } from '../core/data.js';
import { KB_SELECTED, SESSION, CURRENT_PAGE, setKbSelected } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { renderMarkdown } from '../ai/page.js';
import { registerActions, registerInputActions } from '../core/event-delegation.js';
import { apiGet, apiPost, apiPatch, apiDelete, getJwt, getWorkspaceId } from '../core/api-client.js';
import { startPresence } from '../core/presence.js';
import { showModal, closeModal } from '../core/modal.js';
import './sources.js';
import { articleStatus, ARTICLE_STATUS_LABELS, articleLink } from './article-state.js';
import { articleMarket, matchingArticles, DraftSelection, publishDrafts } from './bulk-review.js';
import { cardTitle, updatedLabel, directoryCards, gameDirectory, cardMatchesQuery, articleCategory, articlePreview, articlePage } from './card-presentation.js';
import { filterStorageKey } from './saved-filters.js';
import { createFilterSync } from './filter-sync.js';

function kbApiBacked() {
  return !!(getJwt() && getWorkspaceId());
}

function mapKbResponse(a) {
  return {
    _uuid:    a.id,
    id:       a.display_id,
    title:    a.title,
    category: a.category || '',
    body:     a.body || '',
    status:   a.status || 'draft',
    author:   a.author_name || 'Unknown',
    updated:  a.updated_at || '',
  };
}

let KB_QUERY = '';
let KB_FILTER_CAT = 'all';
let KB_FILTER_STATUS = 'all';
let KB_FILTER_MARKET = 'all';
let KB_PAGE = 0;
let pageScope = '';
let savedFilterId = '', savedFilterScope = '';
const currentFilters = () => ({category:KB_FILTER_CAT,market:KB_FILTER_MARKET,status:KB_FILTER_STATUS,query:KB_QUERY});
const savedKey = () => getJwt() ? filterStorageKey(getWorkspaceId(),SESSION?.userId) : null;
const savedScope = () => JSON.stringify([savedKey(),getJwt()]);
const filterSync = createFilterSync({
  api:{get:apiGet,post:apiPost,patch:apiPatch,delete:apiDelete},
  storage:()=>localStorage, currentScope:savedScope,
  changed:()=>{ if(CURRENT_PAGE==='kb') renderPage('kb'); },
});

function renderSavedFilters() {
  if (savedFilterScope !== savedScope()) { savedFilterId='';savedFilterScope=savedScope(); }
  filterSync.ensure(savedScope(),savedKey());
  if (!savedKey()) return '';
  const {items,phase,error,warning}=filterSync.state;
  const busy=phase==='loading'||phase==='saving';
  if (phase==='loading'||phase==='error') return `<div class="kb-saved-filters"><span role="status">${window.escHtml(error || 'Loading saved filters…')}</span><button type="button" class="btn btn-sm" data-action="kb.refreshFilters" ${busy?'disabled':''}>Refresh</button></div>`;
  if (!items.some(item=>item.id===savedFilterId)) savedFilterId='';
  const selected=items.find(item=>item.id===savedFilterId);
  const pinned=items.filter(item=>item.is_pinned);
  const criteria=currentFilters();
  const matches=items.filter(({filters})=>['category','market','status'].every(key=>filters[key]===criteria[key])
    && filters.query.toLowerCase().trim()===criteria.query.toLowerCase().trim());
  const matchingIds=new Set(matches.map(item=>item.id));
  const matchLabel=matches.length
    ? `${matches.length===1?'Matches saved filter':'Matches saved filters'}: ${matches.map(item=>'“'+item.name+'”').join(', ')}`
    : 'No saved filter matches this view.';
  return `<div class="kb-saved-filters"><label for="kb-saved-filter">Saved filters</label>
    <select class="filter-select" id="kb-saved-filter" data-input-action="kb.pickSaved"><option value="">Choose a saved filter</option>${items.map(item=>`<option value="${window.escAttr(item.id)}" ${item.id===savedFilterId?'selected':''}>${window.escHtml(item.name)}</option>`).join('')}</select>
    <button type="button" class="btn btn-sm" data-action="kb.applySaved" ${busy?'disabled':''}>Apply</button>
    <button type="button" class="btn btn-sm" id="kb-pin-filter" data-action="kb.pinFilter" ${busy||!selected?'disabled':''}>${selected?.is_pinned?'Unpin':'Pin'}</button>
    <button type="button" class="btn btn-sm" data-action="kb.saveFilter" ${busy?'disabled':''}>Save current filters</button>
    <button type="button" class="btn btn-sm" data-action="kb.renameFilter" ${busy?'disabled':''}>Rename</button>
    <button type="button" class="btn btn-sm" data-action="kb.deleteFilter" ${busy?'disabled':''}>Delete</button>
    <button type="button" class="btn btn-sm" data-action="kb.refreshFilters" ${busy?'disabled':''}>Refresh</button><span class="kb-saved-note">Personal · synced across devices</span><span id="kb-saved-status" role="status">${window.escHtml(busy?'Saving…':warning)}</span>
    <span class="kb-filter-match" id="kb-filter-match" role="status">${window.escHtml(matchLabel)}</span>
    ${pinned.length?`<div class="kb-pinned-filters" role="group" aria-label="Pinned filters"><span>Pinned</span>${pinned.map(item=>`<button type="button" class="btn btn-sm${matchingIds.has(item.id)?' btn-solid':''}" id="kb-pinned-${window.escAttr(item.id)}" data-action="kb.applyPinned" data-id="${window.escAttr(item.id)}" aria-label="${window.escAttr('Apply saved filter '+item.name+(matchingIds.has(item.id)?'. Matches current view.':''))}" ${busy||bulkRunning?'disabled':''}>${matchingIds.has(item.id)?'<span aria-hidden="true">✓</span> ':''}${window.escHtml(item.name)}</button>`).join('')}</div>`:''}</div>`;
}
async function pinSavedFilter() {
  const scope=savedScope();
  try {
    const item=selectedSavedFilter(), is_pinned=!item.is_pinned;
    const id=await filterSync.mutate('pin',{id:item.id,is_pinned});
    if(id===null || scope!==savedScope()) return;
    if(CURRENT_PAGE!=='kb') return;
    document.getElementById('kb-pin-filter')?.focus();
    const status=document.getElementById('kb-saved-status');
    if(status)status.textContent=is_pinned?'Filter pinned.':'Filter unpinned. It is still in your saved filters.';
  } catch(error) {if(scope===savedScope()) savedError(error);}
}
function applyPinnedFilter(id) {
  if (bulkRunning || savedFilterScope!==savedScope() || filterSync.state.phase!=='ready') return;
  if (!filterSync.state.items.some(item=>item.id===id && item.is_pinned)) return;
  savedFilterId=id;
  applySavedFilter();
  document.getElementById('kb-pinned-'+id)?.focus();
}
function selectedSavedFilter() {
  if (savedFilterScope !== savedScope()) throw Error('Your session changed. Reopen Knowledge Base.');
  if (filterSync.state.phase !== 'ready') throw Error('Wait for saved filters to load, then try again.');
  const item=filterSync.state.items.find(item=>item.id===savedFilterId);
  if (!item) throw Error('Choose a saved filter first.');
  return item;
}
function savedError(error) {
  const el=document.getElementById('kb-saved-status');
  if(el)el.textContent=error.message || 'Saved filters are unavailable. Try again.';
}
function editSavedFilter(action) {
  try {
    if (!savedKey() || savedFilterScope !== savedScope()) throw Error('Your session changed. Reopen Knowledge Base.');
    const item=action==='save'?null:selectedSavedFilter();
    if (filterSync.state.phase !== 'ready') throw Error('Wait for saved filters to load, then try again.');
    const scope=savedScope(), filters=currentFilters();
    let pending=false;
    showModal(action==='delete'?'Delete saved filter':action==='rename'?'Rename saved filter':'Save current filters',
      `${action==='delete'?`<p>Delete “${window.escHtml(item.name)}” from your saved filters?</p>`:`<label for="kb-filter-name">Filter name</label><input id="kb-filter-name" class="form-input" maxlength="60" value="${window.escAttr(item?.name || '')}" autocomplete="off">`}
      <p>Saved for you in this workspace, across your devices.</p><p id="kb-filter-error" role="alert"></p>`,async ()=>{
        const errorEl=document.getElementById('kb-filter-error');
        if (!errorEl || pending) return;
        if (scope!==savedScope()) {errorEl.textContent='Your session changed. Close this dialog and reopen Knowledge Base.';return;}
        try {
          pending=true;
          errorEl.textContent='Saving…';
          const id=await filterSync.mutate(action,{id:item?.id,name:document.getElementById('kb-filter-name')?.value,filters});
          if(document.getElementById('kb-filter-error')!==errorEl) return;
          if(id===null || scope!==savedScope()) {errorEl.textContent='Your session changed. Close this dialog and reopen Knowledge Base.';return;}
          savedFilterId=id;
          closeModal();renderPage('kb');
          const status=document.getElementById('kb-saved-status');
          if(status)status.textContent=action==='delete'?'Saved filter deleted.':action==='rename'?'Saved filter renamed.':'Filter saved.';
        } catch(error) {if(scope===savedScope() && document.getElementById('kb-filter-error')===errorEl) errorEl.textContent=error.message || 'Could not save the change. Try again.';}
        finally {pending=false;}
      },action==='delete'?'Delete filter':action==='rename'?'Rename filter':'Save filter');
    document.getElementById('kb-filter-name')?.focus();
  } catch(error) {savedError(error);}
}
function applySavedFilter() {
  if (bulkRunning) return;
  try {
    const {filters}=selectedSavedFilter();
    KB_FILTER_CAT=filters.category;KB_FILTER_MARKET=filters.market;KB_FILTER_STATUS=filters.status;KB_QUERY=filters.query;
    KB_PAGE=0;bulkSelection.ids.clear();bulkMessage='';
    renderPage('kb');document.getElementById('kb-saved-filter')?.focus();
    const status=document.getElementById('kb-saved-status');
    if(status)status.textContent='Saved filter applied. Article selection cleared.';
  } catch(error) {savedError(error);}
}
const bulkSelection = new DraftSelection();
let bulkRunning = false;
let bulkMessage = '';
let bulkContext = '';

function bulkScope() {
  return JSON.stringify([getWorkspaceId(), getJwt(), window.isAdmin(), KB_FILTER_CAT, KB_FILTER_MARKET, KB_FILTER_STATUS, KB_QUERY]);
}
function matchingKB(status = KB_FILTER_STATUS) {
  return matchingArticles(KB_ARTICLES, { market: KB_FILTER_MARKET, status })
    .filter(a => (KB_FILTER_CAT === 'all' || articleCategory(a) === KB_FILTER_CAT) && cardMatchesQuery(a, KB_QUERY));
}
function syncBulkSelection() {
  const context = JSON.stringify([getWorkspaceId(), getJwt()]);
  if (bulkContext !== context) { bulkMessage = ''; bulkContext = context; }
  const scope = bulkScope();
  if (bulkSelection.scope !== scope) bulkMessage = '';
  bulkSelection.sync(scope, matchingKB());
}

function statusBadge(a) {
  const status = articleStatus(a);
  return `<span class="kb-status kb-status-${status}">${ARTICLE_STATUS_LABELS[status]}</span>`;
}

let KB_VOTES = (() => { try { return JSON.parse(localStorage.getItem('kb_votes') || '{}'); } catch { return {}; } })();
let KB_USER_VOTES = (() => { try { return JSON.parse(localStorage.getItem('kb_user_votes') || '{}'); } catch { return {}; } })();
let KB_VIEWS = (() => { try { return JSON.parse(localStorage.getItem('kb_views') || '{}'); } catch { return {}; } })();

function articleSnippet(a) { return articlePreview(a); }

function saveKBState() {
  try {
    localStorage.setItem('kb_votes',      JSON.stringify(KB_VOTES));
    localStorage.setItem('kb_user_votes', JSON.stringify(KB_USER_VOTES));
    localStorage.setItem('kb_views',      JSON.stringify(KB_VIEWS));
  } catch {}
}

function getKBViews(id) {
  // API-backed: server-stamped view_count on the article row.
  const a = KB_ARTICLES.find(x => x.id === id);
  if (a?._uuid) return a.viewCount || 0;
  // Demo persona — fall back to localStorage + deterministic seed.
  if (KB_VIEWS[id] != null) return KB_VIEWS[id];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return 50 + (h % 350);
}

function getKBNetVote(id) {
  const a = KB_ARTICLES.find(x => x.id === id);
  if (a?._uuid) return (a.helpfulCount || 0) - (a.unhelpfulCount || 0);
  return KB_VOTES[id] || 0;
}

function getKBUserVote(id) {
  const a = KB_ARTICLES.find(x => x.id === id);
  if (a?._uuid) {
    if (a.myVote === 1)  return 'up';
    if (a.myVote === -1) return 'down';
    return undefined;
  }
  return KB_USER_VOTES[id];
}

async function incrementKBView(id) {
  const a = KB_ARTICLES.find(x => x.id === id);
  if (a?._uuid) {
    try {
      const res = await apiPost(`/api/v1/kb-articles/${a._uuid}/view`, {});
      a.viewCount = res.view_count;
    } catch (err) {
      // Best-effort — a missed view ping isn't worth alerting the user.
      console.warn('[kb] view increment failed:', err);
    }
    return;
  }
  KB_VIEWS[id] = (getKBViews(id) || 0) + 1;
  saveKBState();
}

function readingTime(body) {
  const words = (body || '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

async function voteKB(id, dir) {
  const a = KB_ARTICLES.find(x => x.id === id);
  if (!a) return;
  // 'up' / 'down' toggles: if the user clicks the same direction
  // they previously voted, that's a clear; otherwise it's a switch
  // (which may be from no-vote, up→down, or down→up).
  const prev = getKBUserVote(id);
  const direction = prev === dir ? 'clear' : dir;
  if (a._uuid) {
    let res;
    try { res = await apiPost(`/api/v1/kb-articles/${a._uuid}/vote`, { direction }); }
    catch (err) { alert(`Couldn't vote: ${err?.message || err}`); return; }
    a.myVote         = res.my_vote;
    a.helpfulCount   = res.helpful_count;
    a.unhelpfulCount = res.unhelpful_count;
    renderPage('kb');
    return;
  }
  // Demo persona — keep the localStorage path.
  let v = KB_VOTES[id] || 0;
  if (prev === dir) {
    v -= dir === 'up' ? 1 : -1;
    delete KB_USER_VOTES[id];
  } else if (prev) {
    v += (dir === 'up' ? 2 : -2);
    KB_USER_VOTES[id] = dir;
  } else {
    v += dir === 'up' ? 1 : -1;
    KB_USER_VOTES[id] = dir;
  }
  KB_VOTES[id] = v;
  saveKBState();
  renderPage('kb');
}

function toggleKBFeatured(id) {
  if (!window.isAdmin()) return;
  const a = KB_ARTICLES.find(x => x.id === id);
  if (!a) return;
  a.featured = !a.featured;
  renderPage('kb');
}

function getRelatedArticles(article) {
  const tokens = (article.title + ' ' + article.body).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const tokenSet = new Set(tokens);
  const scored = KB_ARTICLES.filter(a => a.id !== article.id).map(a => {
    let score = 0;
    if (a.category === article.category) score += 5;
    const aTokens = (a.title + ' ' + a.body).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
    aTokens.forEach(t => { if (tokenSet.has(t)) score += 1; });
    return { a, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  return scored.map(x => x.a);
}

function highlightSearch(text, query) {
  if (!query || !query.trim()) return text;
  const terms = query.trim().split(/\s+/).filter(t => t.length > 1);
  let out = text;
  terms.forEach(term => {
    const re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  });
  return out;
}

function renderGameDirectory(group, admin) {
  const drafts = group.articles.filter(a => a._uuid && articleStatus(a) === 'draft');
  const selected = drafts.filter(a => bulkSelection.ids.has(a._uuid)).length;
  return `<details class="kb-card kb-directory" data-directory="${window.escAttr(group.key)}">
    <summary>
      <div class="kb-card-cat">Games · ${window.escHtml(group.market)}</div>
      <div class="kb-card-t">${window.escHtml(group.title)}</div>
      <div class="kb-updated">${window.escHtml(updatedLabel(group.updated))}</div>
      <div class="kb-directory-status">${Object.entries(group.counts).filter(([, n]) => n).map(([s, n]) => `<span class="kb-status kb-status-${s}">${n} ${ARTICLE_STATUS_LABELS[s]}</span>`).join('')}</div>
      <div class="kb-directory-hint">${group.articles.length} game links</div>
    </summary>
    ${admin && drafts.length ? `<button class="btn btn-sm" data-action="kb.selectDirectory" data-directory="${window.escAttr(group.key)}" ${bulkRunning ? 'disabled' : ''}>${selected === drafts.length ? 'Clear' : 'Select'} ${drafts.length} matching drafts</button>` : ''}
    <ul class="kb-directory-list">${group.articles.map(a => `<li>
      <div class="kb-directory-game"><a href="${window.escAttr(articleLink(a.body))}" target="_blank" rel="noopener noreferrer">${window.escHtml(cardTitle(a))} ↗</a>
        <div class="kb-updated">${window.escHtml(updatedLabel(a.updated))}</div>${statusBadge(a)}</div>
      <div class="kb-directory-actions"><button class="btn btn-sm" data-action="kb.open" data-id="${window.escAttr(a.id)}">Review</button>
      ${admin && a._uuid && articleStatus(a) === 'draft' ? `<label class="kb-select-draft" data-action=""><input type="checkbox" data-action="kb.selectDraft" data-uuid="${window.escAttr(a._uuid)}" aria-label="Select ${window.escAttr(cardTitle(a))}" ${bulkSelection.ids.has(a._uuid) ? 'checked' : ''} ${bulkRunning ? 'disabled' : ''}/> Select</label>` : ''}</div>
    </li>`).join('')}</ul>
  </details>`;
}

function renderSelection(focusUuid) {
  const open = [...(document.querySelectorAll?.('.kb-directory[open]') || [])].map(el => ({ key: el.dataset.directory, scroll: el.querySelector('.kb-directory-list')?.scrollTop || 0 }));
  const scrollTop = document.querySelector?.('.kb-main .page-scroll')?.scrollTop || 0;
  renderPage('kb');
  for (const entry of open) {
    const el = document.querySelector?.(`[data-directory="${entry.key}"].kb-directory`);
    if (el) { el.open = true; el.querySelector('.kb-directory-list').scrollTop = entry.scroll; }
  }
  const scroller = document.querySelector?.('.kb-main .page-scroll');
  if (scroller) scroller.scrollTop = scrollTop;
  if (focusUuid) document.querySelector?.(`[data-action="kb.selectDraft"][data-uuid="${focusUuid}"]`)?.focus({ preventScroll: true });
}

export function renderKB() {
  syncBulkSelection();
  if (KB_SELECTED) return renderKBArticle(KB_SELECTED);
  const scope = bulkScope();
  if (scope !== pageScope) { KB_PAGE = 0; pageScope = scope; }
  const admin = window.isAdmin();
  const ql = KB_QUERY.toLowerCase().trim();

  let list = matchingKB('all');
  const statusCounts = { all: list.length, draft: 0, published: 0, archived: 0 };
  list.forEach(a => statusCounts[articleStatus(a)]++);
  if (KB_FILTER_STATUS !== 'all') list = list.filter(a => articleStatus(a) === KB_FILTER_STATUS);
  list.sort((a, b) => {
    if (a.featured && !b.featured) return -1;
    if (!a.featured && b.featured) return 1;
    return (b.updated || '').localeCompare(a.updated || '');
  });

  const grouped = directoryCards(list);
  const page = articlePage(grouped, KB_PAGE);
  KB_PAGE = page.page;
  const cards = page.entries.map(card => {
    if (!card.article) return renderGameDirectory(card, admin);
    const a = card.article;
    const titleHtml   = ql ? highlightSearch(window.escHtml(cardTitle(a)),         KB_QUERY) : window.escHtml(cardTitle(a));
    const snippetHtml = ql ? highlightSearch(window.escHtml(articleSnippet(a)), KB_QUERY) : window.escHtml(articleSnippet(a));
    return `
      <article class="kb-list-row">
        <div class="kb-row-content">
          <button type="button" class="kb-row-title" data-action="kb.open" data-id="${window.escAttr(a.id)}">${titleHtml}</button>
          <p class="kb-row-preview">${snippetHtml || 'Open article to view its content.'}</p>
          <div class="kb-row-meta"><span>${window.escHtml(articleCategory(a))}</span><span>${window.escHtml(articleMarket(a) === 'unassigned' ? 'Unassigned market' : articleMarket(a))}</span><span>${window.escHtml(a.id)}</span>${a.featured ? '<span>★ Featured</span>' : ''}</div>
        </div>
        <div class="kb-row-state">${statusBadge(a)}<span class="kb-updated">${window.escHtml(updatedLabel(a.updated))}</span>
          ${admin && a._uuid && articleStatus(a) === 'draft' ? `<label class="kb-select-draft" data-action=""><input type="checkbox" data-action="kb.selectDraft" data-uuid="${window.escAttr(a._uuid)}" aria-label="Select ${window.escAttr(a.title)}" ${bulkSelection.ids.has(a._uuid) ? 'checked' : ''} ${bulkRunning ? 'disabled' : ''}/> Select</label>` : ''}
        </div>
      </article>`;
  }).join('');

  const catCounts = Object.create(null);
  KB_ARTICLES.forEach(a => { const cat = articleCategory(a); catCounts[cat] = (catCounts[cat] || 0) + 1; });
  if (KB_FILTER_CAT !== 'all' && !Object.hasOwn(catCounts,KB_FILTER_CAT)) catCounts[KB_FILTER_CAT]=0;
  const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);

  return `
    <div class="page kb-library-page">
      <div class="topbar">
        <div class="tb-title">Knowledge Base</div>
        ${admin && kbApiBacked() ? `<button class="btn btn-sm" data-action="ks.open">Knowledge sources</button>` : ''}
        ${admin ? `<button class="btn btn-solid btn-sm" data-action="kb.new">+ New Article</button>` : ''}
      </div>
      <div class="kb-layout">
        <aside class="kb-sidebar">
          <div style="padding:12px 14px;border-bottom:1px solid var(--rule)">
            <div class="ts-heading" style="margin:0">Categories</div>
          </div>
          <div class="kb-cat-list">
            <button type="button" class="kb-cat-item ${KB_FILTER_CAT==='all'?'active':''}" data-action="kb.setCat" data-cat="all" aria-pressed="${KB_FILTER_CAT==='all'}">
              <span class="kb-cat-name">All articles</span>
              <span class="kb-cat-count">${KB_ARTICLES.length}</span>
            </button>
            ${sortedCats.map(([cat, count]) => `
              <button type="button" class="kb-cat-item ${KB_FILTER_CAT===cat?'active':''}" data-action="kb.setCat" data-cat="${window.escAttr(cat)}" aria-pressed="${KB_FILTER_CAT===cat}">
                <span class="kb-cat-name">${window.escHtml(cat)}</span>
                <span class="kb-cat-count">${count}</span>
              </button>`).join('')}
          </div>
        </aside>
        <div class="kb-main">
          ${renderSavedFilters()}
          <div class="kb-status-filters" role="group" aria-label="Article status">
            ${Object.entries({ all: 'All articles', ...ARTICLE_STATUS_LABELS }).map(([status, label]) => `
              <button class="btn btn-sm" aria-pressed="${KB_FILTER_STATUS === status}" data-action="kb.setStatus" data-status="${status}">${label} <span>${statusCounts[status]}</span></button>
            `).join('')}
          </div>
          <div class="filter-bar">
            <label for="kb-market">Market / language</label>
            <select id="kb-market" class="filter-select" data-input-action="kb.setMarket">
              <option value="all">All markets / languages</option>
              ${[...new Set([...KB_ARTICLES.map(articleMarket),...(KB_FILTER_MARKET==='all'?[]:[KB_FILTER_MARKET])])].sort().map(m => `<option value="${window.escAttr(m)}" ${KB_FILTER_MARKET === m ? 'selected' : ''}>${m === 'unassigned' ? 'Unassigned' : window.escHtml(m)}</option>`).join('')}
            </select>
            <span class="filter-label">Search</span>
            <input class="filter-select" aria-label="Search articles" placeholder="Search articles…" style="width:280px" value="${window.escAttr(KB_QUERY)}" data-input-action="kb.setQuery"/>
            <span class="kb-result-count">${list.length} of ${KB_ARTICLES.length} articles · ${grouped.length} entries including game directories</span>
          </div>
          ${admin && kbApiBacked() && (KB_FILTER_STATUS === 'draft' || bulkSelection.ids.size || bulkRunning || bulkMessage) ? `<div class="kb-bulk-bar">
            <button class="btn btn-sm" data-action="kb.selectMatching" ${bulkRunning || !list.some(a => a._uuid && articleStatus(a) === 'draft') ? 'disabled' : ''}>Select all matching drafts</button>
            <button class="btn btn-sm" data-action="kb.clearSelection" ${bulkRunning || !bulkSelection.ids.size ? 'disabled' : ''}>Clear selection</button>
            <span>${bulkSelection.ids.size} selected across all pages</span>
            <button class="btn btn-solid btn-sm" data-action="kb.publishSelected" ${bulkRunning || !bulkSelection.ids.size ? 'disabled' : ''}>Publish selected</button>
            <span role="status" aria-live="polite">${window.escHtml(bulkMessage)}</span>
          </div>` : ''}
          <div class="page-scroll">
            ${list.length ? `<div class="kb-article-list">${cards}</div>` : `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No articles match. Change your search or filters.</div><div class="empty-line"></div></div>`}
          </div>
          ${grouped.length ? `<nav class="kb-pagination" tabindex="-1" aria-label="Article list pages"><span>Entries ${page.first}–${page.last} of ${grouped.length} · Page ${page.page+1} of ${page.pages}</span><button type="button" class="btn btn-sm" data-action="kb.page" data-page="${page.page-1}" ${page.page===0?'disabled':''}>Previous</button><button type="button" class="btn btn-sm" data-action="kb.page" data-page="${page.page+1}" ${page.page+1===page.pages?'disabled':''}>Next</button></nav>` : ''}
        </div>
      </div>
    </div>`;
}

function renderKBArticle(id) {
  const a = KB_ARTICLES.find(x => x.id === id);
  if (!a) { setKbSelected(null); return renderKB(); }
  // Real-time presence — no-ops for demo articles (no _uuid). Useful
  // on the edit path when two admins might fight over the same article;
  // also nice on read so authors see when their article is hot.
  // No #presence-banner slot here — banner is the typing-indicator
  // strip that pairs with a composer; KB-article view has no composer.
  if (a._uuid && SESSION?.userId) startPresence('kb_article', a._uuid);
  const admin = window.isAdmin();
  const views = getKBViews(id);
  const votes = getKBNetVote(id);
  const userVote = getKBUserVote(id);
  const reading = readingTime(a.body);
  const wordCount = (a.body || '').split(/\s+/).filter(Boolean).length;
  const related = getRelatedArticles(a);
  const status = articleStatus(a);
  const link = articleLink(a.body);
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span data-action="kb.close">Knowledge Base</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${a.id}</span>
          <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
            <div id="presence-chips" class="presence-chips" aria-label="Agents viewing this article"></div>
            ${admin ? `
            <button class="btn btn-sm" data-action="kb.toggleFeatured" data-id="${window.escAttr(a.id)}">${a.featured?'★ Unfeature':'☆ Feature'}</button>
            <button class="btn btn-sm" data-action="kb.edit" data-id="${window.escAttr(a.id)}">Edit</button>
            <button class="btn btn-sm btn-danger" data-action="kb.delete" data-id="${window.escAttr(a.id)}">Delete</button>
            ` : ''}
          </span>
        </div>
      </div>
      <div class="page-scroll">
        <div class="kb-article">
          <div class="kb-card-cat" style="display:flex;align-items:center;gap:8px">
            <span>${window.escHtml(a.category)}</span>
            ${a.featured ? '<span style="color:var(--amber);font-weight:600">★ Featured</span>' : ''}
          </div>
          <h1 class="kb-article-h">${window.escHtml(cardTitle(a))}</h1>
          <div class="kb-review-banner">
            <div>${statusBadge(a)}<p>${status === 'draft' ? 'Review the content, then publish it to make it available to AI.' : status === 'published' ? 'AI can use this article in customer replies.' : 'This article is archived and unavailable to AI.'}</p></div>
            ${admin && status === 'draft' ? `<button class="btn btn-solid" data-action="kb.publish" data-id="${window.escAttr(a.id)}">Publish article</button>` : ''}
          </div>
          <div class="kb-article-meta">
            <span>${a.id}</span>
            <span>By ${window.escHtml(a.author)}</span>
            <span>${window.escHtml(updatedLabel(a.updated))}</span>
            <span>${views} view${views===1?'':'s'}</span>
            ${link ? '' : `<span>${reading} min read · ${wordCount} words</span>`}
            ${votes !== 0 ? `<span style="color:${votes>0?'var(--green)':'var(--red)'}">${votes>0?'+':''}${votes} helpful</span>` : ''}
          </div>
          ${link ? `<a class="kb-article-link" href="${window.escAttr(link)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${window.escAttr(a.title)}" title="${window.escAttr(link)}"><strong>${new URL(link).pathname.includes('/games/') ? 'Open game' : 'Open link'} ↗</strong><span>${window.escHtml(new URL(link).hostname)}</span></a>` : `<div class="ai-md">${renderMarkdown(a.body)}</div>`}

          <div class="kb-helpful-card">
            <div style="font-size:13px;font-weight:500;color:var(--ink);margin-bottom:12px">Was this article helpful?</div>
            <div style="display:flex;gap:10px;justify-content:center;align-items:center;flex-wrap:wrap">
              <button class="btn btn-sm" data-action="kb.vote" data-id="${window.escAttr(a.id)}" data-vote="up" style="${userVote==='up'?'border-color:var(--green);color:var(--green);background:var(--green-lt)':''}">👍 Yes</button>
              <button class="btn btn-sm" data-action="kb.vote" data-id="${window.escAttr(a.id)}" data-vote="down" style="${userVote==='down'?'border-color:var(--red);color:var(--red);background:var(--red-lt)':''}">👎 No</button>
              ${votes !== 0 ? `<span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:8px">Net score: ${votes>0?'+':''}${votes}</span>` : ''}
            </div>
          </div>

          ${related.length ? `
          <div style="margin-top:28px">
            <div class="ts-heading" style="margin-bottom:10px">Related articles</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
              ${related.map(r => `
                <div class="kb-card" data-action="kb.open" data-id="${window.escAttr(r.id)}" style="padding:12px">
                  <div class="kb-card-cat" style="margin-bottom:6px">${window.escHtml(r.category)}</div>
                  ${statusBadge(r)}
                  <div class="kb-card-t" style="font-size:13px">${window.escHtml(cardTitle(r))}</div><div class="kb-updated">${window.escHtml(updatedLabel(r.updated))}</div>
                </div>`).join('')}
            </div>
          </div>` : ''}
        </div>
      </div>
    </div>`;
}

function kbSetQuery(q) {
  const wasFocused = document.activeElement;
  KB_QUERY = q;
  renderPage('kb');
  // restore focus to the input that had it
  const input = document.querySelector('.filter-bar input');
  if (input && wasFocused?.tagName === 'INPUT') {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}
function kbSetCat(c) { KB_FILTER_CAT = c; renderPage('kb'); }
function kbSetStatus(status) {
  if (status !== 'all' && !Object.hasOwn(ARTICLE_STATUS_LABELS, status)) return;
  KB_FILTER_STATUS = status;
  renderPage('kb');
}
function openKBArticle(id) { incrementKBView(id); setKbSelected(id); renderPage('kb'); }
function closeKBArticle()  { setKbSelected(null); renderPage('kb'); }

function kbArticleForm(initial) {
  const cats = [...new Set(KB_ARTICLES.map(a => a.category))];
  const a = initial || {title:'', category:cats[0]||'Getting Started', body:''};
  return `
    <div class="form-row"><label class="form-label" for="kb-title">Title</label><input class="form-input" id="kb-title" value="${window.escAttr(a.title)}"/></div>
    <div class="form-row"><label class="form-label" for="kb-cat">Category</label>
      <input class="form-input" id="kb-cat" list="kb-cat-list" value="${window.escAttr(a.category)}"/>
      <datalist id="kb-cat-list">${cats.map(c => `<option value="${window.escAttr(c)}">`).join('')}</datalist>
    </div>
    <div class="form-row"><label class="form-label" for="kb-body">Body</label><textarea class="form-input" id="kb-body" style="min-height:240px;font-family:'Inter',sans-serif">${window.escHtml(a.body)}</textarea></div>
    <p class="kb-form-note">${!initial || articleStatus(initial) === 'draft' ? 'Saved as a draft. AI can use it after you review and publish it.' : articleStatus(initial) === 'published' ? 'Changes to this published article will be available to AI as soon as you save.' : 'Saving changes keeps this article archived.'}</p>`;
}

function kbNewArticle() {
  if (!window.isAdmin()) return;
  const workspace = getWorkspaceId();
  const jwt = getJwt();
  let saving = false;
  showModal('New article', kbArticleForm(null), async () => {
    if (saving || workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    const title = document.getElementById('kb-title').value.trim();
    const cat   = document.getElementById('kb-cat').value.trim() || 'Getting Started';
    const body  = document.getElementById('kb-body').value;
    if (!title || !body.trim()) return;
    if (kbApiBacked()) {
      let resp;
      saving = true;
      try { resp = await apiPost('/api/v1/kb-articles', { title, category: cat, body, status: 'draft' }); }
      catch (err) { saving = false; alert(`Couldn't save draft: ${err?.message || err}`); return; }
      if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
      KB_ARTICLES.unshift(mapKbResponse(resp.article));
    } else {
      const id = 'KB-' + String(KB_ARTICLES.length + 1).padStart(3, '0');
      KB_ARTICLES.unshift({id, title, category:cat, body, status:'draft', author:SESSION?.name||'Unknown', updated:new Date().toISOString()});
    }
    setKbSelected(KB_ARTICLES[0].id);
    closeModal(); renderPage('kb');
  }, 'Save draft', true);
}

function kbEditArticle(id) {
  if (!window.isAdmin()) return;
  const a = KB_ARTICLES.find(x => x.id === id); if (!a) return;
  const workspace = getWorkspaceId();
  const jwt = getJwt();
  showModal('Edit article', kbArticleForm(a), async () => {
    if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    const title = document.getElementById('kb-title').value.trim();
    const cat   = document.getElementById('kb-cat').value.trim() || a.category;
    const body  = document.getElementById('kb-body').value;
    if (!title || !body.trim()) return;
    let updated = new Date().toISOString();
    if (a._uuid) {
      try {
        const { article } = await apiPatch(`/api/v1/kb-articles/${a._uuid}`, { title, category: cat, body });
        updated = article.updated_at || a.updated;
      }
      catch (err) { alert(`Couldn't save: ${err?.message || err}`); return; }
      if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    }
    a.title = title; a.category = cat; a.body = body;
    a.updated = updated;
    closeModal(); renderPage('kb');
  }, articleStatus(a) === 'draft' ? 'Save draft' : 'Save changes', true);
}

function kbPublishArticle(id) {
  if (!window.isAdmin()) return;
  const a = KB_ARTICLES.find(x => x.id === id);
  if (!a || articleStatus(a) !== 'draft') return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  let saving = false;
  showModal('Publish article', `<p>Publish <strong>${window.escHtml(a.title)}</strong>?</p><p>AI will be able to use this content in customer replies.</p>`, async () => {
    if (saving || !window.isAdmin() || workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    saving = true;
    const button = document.querySelector?.('#modal-container [data-action="modal.confirm"]');
    if (button) { button.disabled = true; button.textContent = 'Publishing…'; }
    if (a._uuid) {
      try {
        const { article } = await apiPatch(`/api/v1/kb-articles/${a._uuid}`, { status: 'published' });
        if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
        if (article.status !== 'published') throw new Error('The article was not published. Try again.');
        a.status = article.status;
        a.updated = article.updated_at || '';
      } catch (err) {
        saving = false;
        if (button?.isConnected) { button.disabled = false; button.textContent = 'Publish article'; }
        alert(`Couldn't publish: ${err?.message || err}`);
        return;
      }
    } else {
      a.status = 'published';
    }
    closeModal(); renderPage('kb');
  }, 'Publish article');
}

function kbPublishSelected() {
  if (bulkRunning || !window.isAdmin() || !kbApiBacked()) return;
  syncBulkSelection();
  const selected = bulkSelection.selected(matchingKB());
  if (!selected.length) return;
  const countLabel = `${selected.length} article${selected.length === 1 ? '' : 's'}`;
  const scope = bulkScope();
  const workspace = getWorkspaceId(), jwt = getJwt();
  const sameSession = () => workspace === getWorkspaceId() && jwt === getJwt() && window.isAdmin()
    && selected.every(a => KB_ARTICLES.includes(a));
  const markets = {};
  selected.forEach(a => { const m = articleMarket(a); markets[m] = (markets[m] || 0) + 1; });
  showModal('Publish selected articles', `
    <p>Publish <strong>${countLabel}</strong>? AI will be able to use them in customer replies.</p>
    <ul>${Object.entries(markets).sort().map(([m, n]) => `<li>${window.escHtml(m === 'unassigned' ? 'Unassigned' : m)}: ${n}</li>`).join('')}</ul>
    <details><summary>Review selected titles</summary><ul class="kb-bulk-titles">${selected.map(a => `<li>${window.escHtml(a.title)}</li>`).join('')}</ul></details>
    <p id="kb-bulk-progress" role="status" aria-live="polite">Closing this dialog stops after the current request. Completed articles stay published.</p>`, async () => {
    if (bulkRunning || !sameSession() || scope !== bulkScope()) return;
    bulkRunning = true;
    try {
      const progress = document.getElementById('kb-bulk-progress');
      const button = document.querySelector('#modal-container [data-action="modal.confirm"]');
      button.disabled = true;
      button.textContent = 'Publishing…';
      const cancel = document.querySelector('#modal-container .modal-foot [data-action="modal.close"]');
      if (cancel) cancel.textContent = 'Stop after current article';
      progress.textContent = `Publishing 0 of ${selected.length}…`;
      const result = await publishDrafts(selected, {
        active: sameSession,
        shouldContinue: () => progress.isConnected,
        publish: a => apiPatch(`/api/v1/kb-articles/${a._uuid}`, { status: 'published' }),
        onSuccess: (a, response) => {
          a.status = response.status;
          a.updated = response.updated_at || '';
          bulkSelection.ids.delete(a._uuid);
        },
        onProgress: result => {
          if (progress.isConnected) progress.textContent = `${result.published} of ${selected.length} published. ${result.failures.length} failed.`;
        },
      });
      bulkRunning = false;
      if (!sameSession()) return;
      bulkMessage = `${result.published} published. ${selected.length - result.published} not published.`;
      if (CURRENT_PAGE === 'kb') renderPage('kb');
      if (!progress.isConnected) return;
      showModal('Publishing results', `<p>${window.escHtml(bulkMessage)}</p>${result.failures.length ? `<p>Failed articles remain selected so you can retry.</p><ul class="kb-bulk-titles">${result.failures.map(f => `<li>${window.escHtml(f.article.title)}: ${window.escHtml(f.message)}</li>`).join('')}</ul>` : ''}`, null);
    } catch (error) {
      if (sameSession()) {
        alert(`Publishing stopped: ${error?.message || error}. Reopen Publish selected to retry remaining drafts.`);
      }
    } finally {
      bulkRunning = false;
    }
  }, `Publish ${countLabel}`, true);
}

function kbDeleteArticle(id) {
  if (!window.isAdmin()) return;
  const a = KB_ARTICLES.find(x => x.id === id); if (!a) return;
  showModal('Delete article', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${window.escHtml(a.title)}</strong>? This cannot be undone.</div>`, async () => {
    if (a._uuid) {
      try { await apiDelete(`/api/v1/kb-articles/${a._uuid}`); }
      catch (err) { alert(`Couldn't delete: ${err?.message || err}`); return; }
    }
    const i = KB_ARTICLES.findIndex(x => x.id === id);
    if (i >= 0) KB_ARTICLES.splice(i, 1);
    setKbSelected(null);
    closeModal(); renderPage('kb');
  }, 'Delete');
}

registerActions({
  'kb.pinFilter':pinSavedFilter,
  'kb.applyPinned':ds=>applyPinnedFilter(ds.id),
  'kb.refreshFilters':()=>filterSync.refresh(),
  'kb.applySaved': applySavedFilter,
  'kb.saveFilter':()=>editSavedFilter('save'),
  'kb.renameFilter':()=>editSavedFilter('rename'),
  'kb.deleteFilter':()=>editSavedFilter('delete'),
  'kb.page': (ds) => { KB_PAGE = Number(ds.page); renderPage('kb'); document.querySelector('.kb-pagination')?.focus(); },
  'kb.selectDirectory': ds => {
    if (bulkRunning || !window.isAdmin()) return;
    syncBulkSelection();
    const drafts = matchingKB().filter(a => a._uuid && articleStatus(a) === 'draft' && gameDirectory(a)?.key === ds.directory);
    const clear = drafts.every(a => bulkSelection.ids.has(a._uuid));
    drafts.forEach(a => { if (clear) bulkSelection.ids.delete(a._uuid); else bulkSelection.ids.add(a._uuid); });
    renderSelection();
  },
  'kb.selectDraft': (ds, el) => {
    if (bulkRunning || !window.isAdmin()) return;
    syncBulkSelection();
    const a = matchingKB().find(a => a._uuid === ds.uuid && articleStatus(a) === 'draft');
    if (!a) return;
    if (el.checked) bulkSelection.ids.add(a._uuid); else bulkSelection.ids.delete(a._uuid);
    renderSelection(a._uuid);
  },
  'kb.selectMatching': () => {
    if (bulkRunning || !window.isAdmin()) return;
    syncBulkSelection();
    matchingKB().filter(a => a._uuid && articleStatus(a) === 'draft').forEach(a => bulkSelection.ids.add(a._uuid));
    renderPage('kb');
  },
  'kb.clearSelection': () => { if (!bulkRunning) { bulkSelection.ids.clear(); renderPage('kb'); } },
  'kb.publishSelected': () => kbPublishSelected(),
  'kb.open':           (ds) => openKBArticle(ds.id),
  'kb.close':          () => closeKBArticle(),
  'kb.new':            () => kbNewArticle(),
  'kb.edit':           (ds) => kbEditArticle(ds.id),
  'kb.publish':        (ds) => kbPublishArticle(ds.id),
  'kb.delete':         (ds) => kbDeleteArticle(ds.id),
  'kb.toggleFeatured': (ds) => toggleKBFeatured(ds.id),
  'kb.setCat':         (ds) => kbSetCat(ds.cat),
  'kb.setStatus':      (ds) => kbSetStatus(ds.status),
  'kb.vote':           (ds) => voteKB(ds.id, ds.vote),
});

registerInputActions({
  'kb.pickSaved':(_ds,el)=>{ if(savedFilterScope===savedScope()) {savedFilterId=el.value;renderPage('kb');document.getElementById('kb-saved-filter')?.focus();} },
  'kb.setMarket': (ds, el) => { KB_FILTER_MARKET = el.value; renderPage('kb'); document.getElementById('kb-market')?.focus(); },
  'kb.setQuery': (ds, el) => kbSetQuery(el.value),
});
