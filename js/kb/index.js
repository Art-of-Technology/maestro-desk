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
// External reaches (interim, via window): isAdmin, escAttr, escHtml,
// showModal, closeModal, renderPage — all still in app.js.
//
// KB_ARTICLES comes from data.js via the global lexical env; KB_SELECTED
// and SESSION come from core/state.js the same way.

import { renderMarkdown } from '../ai/page.js';
import { registerActions, registerInputActions } from '../core/event-delegation.js';
import { apiPost, apiPatch, apiDelete } from '../core/api-client.js';

function kbApiBacked() {
  return KB_ARTICLES.some((a) => a._uuid);
}

function kbApiBacked() {
  return KB_ARTICLES.some((a) => a._uuid);
}

function mapKbResponse(a) {
  return {
    _uuid:    a.id,
    id:       a.display_id,
    title:    a.title,
    category: a.category || '',
    body:     a.body || '',
    author:   a.author_name || 'Unknown',
    updated:  (a.updated_at || '').slice(0, 10),
  };
}

let KB_QUERY = '';
let KB_FILTER_CAT = 'all';

let KB_VOTES = (() => { try { return JSON.parse(localStorage.getItem('kb_votes') || '{}'); } catch { return {}; } })();
let KB_USER_VOTES = (() => { try { return JSON.parse(localStorage.getItem('kb_user_votes') || '{}'); } catch { return {}; } })();
let KB_VIEWS = (() => { try { return JSON.parse(localStorage.getItem('kb_views') || '{}'); } catch { return {}; } })();

function articleSnippet(a) { return a.body.replace(/\n+/g, ' ').slice(0, 180); }

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
    window.renderPage('kb');
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
  window.renderPage('kb');
}

function toggleKBFeatured(id) {
  if (!window.isAdmin()) return;
  const a = KB_ARTICLES.find(x => x.id === id);
  if (!a) return;
  a.featured = !a.featured;
  window.renderPage('kb');
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

export function renderKB() {
  if (KB_SELECTED) return renderKBArticle(KB_SELECTED);
  const admin = window.isAdmin();
  const ql = KB_QUERY.toLowerCase().trim();

  let list = KB_ARTICLES.filter(a => KB_FILTER_CAT === 'all' || a.category === KB_FILTER_CAT);
  if (ql) list = list.filter(a => a.title.toLowerCase().includes(ql) || a.body.toLowerCase().includes(ql) || a.category.toLowerCase().includes(ql) || a.id.toLowerCase().includes(ql));
  list.sort((a, b) => {
    if (a.featured && !b.featured) return -1;
    if (!a.featured && b.featured) return 1;
    return (b.updated || '').localeCompare(a.updated || '');
  });

  const cards = list.map(a => {
    const views = getKBViews(a.id);
    const votes = getKBNetVote(a.id);
    const titleHtml   = ql ? highlightSearch(window.escHtml(a.title),         KB_QUERY) : window.escHtml(a.title);
    const snippetHtml = ql ? highlightSearch(window.escHtml(articleSnippet(a)), KB_QUERY) : window.escHtml(articleSnippet(a));
    return `
      <div class="kb-card" data-action="kb.open" data-id="${window.escAttr(a.id)}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
          <div class="kb-card-cat" style="margin:0">${a.category}</div>
          ${a.featured ? '<span style="font-size:9px;color:var(--amber);text-transform:uppercase;letter-spacing:.06em;font-weight:600">★ Featured</span>' : ''}
        </div>
        <div class="kb-card-t">${titleHtml}</div>
        <div class="kb-card-snippet">${snippetHtml}</div>
        <div class="kb-card-meta">
          <span>${a.id}</span>
          <span style="display:flex;gap:10px;align-items:center">
            <span title="Views">${views} view${views===1?'':'s'}</span>
            ${votes !== 0 ? `<span style="color:${votes>0?'var(--green)':'var(--red)'}" title="Helpful score">${votes>0?'+':''}${votes}</span>` : ''}
          </span>
        </div>
      </div>`;
  }).join('');

  const catCounts = {};
  KB_ARTICLES.forEach(a => { catCounts[a.category] = (catCounts[a.category] || 0) + 1; });
  const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Knowledge Base</div>
        ${admin ? `<button class="btn btn-solid btn-sm" data-action="kb.new">+ New Article</button>` : ''}
      </div>
      <div class="kb-layout">
        <aside class="kb-sidebar">
          <div style="padding:12px 14px;border-bottom:1px solid var(--rule)">
            <div class="ts-heading" style="margin:0">Categories</div>
          </div>
          <div class="kb-cat-list">
            <div class="kb-cat-item ${KB_FILTER_CAT==='all'?'active':''}" data-action="kb.setCat" data-cat="all">
              <span class="kb-cat-name">All articles</span>
              <span class="kb-cat-count">${KB_ARTICLES.length}</span>
            </div>
            ${sortedCats.map(([cat, count]) => `
              <div class="kb-cat-item ${KB_FILTER_CAT===cat?'active':''}" data-action="kb.setCat" data-cat="${window.escAttr(cat)}">
                <span class="kb-cat-name">${cat}</span>
                <span class="kb-cat-count">${count}</span>
              </div>`).join('')}
          </div>
        </aside>
        <div class="kb-main">
          <div class="filter-bar">
            <span class="filter-label">Search</span>
            <input class="filter-select" placeholder="Search articles…" style="width:280px" value="${KB_QUERY}" data-input-action="kb.setQuery"/>
            <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${KB_ARTICLES.length} articles${KB_FILTER_CAT!=='all'?` · ${KB_FILTER_CAT}`:''}</span>
          </div>
          <div class="page-scroll">
            ${list.length ? `<div class="kb-grid">${cards}</div>` : `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No articles match</div><div class="empty-line"></div></div>`}
          </div>
        </div>
      </div>
    </div>`;
}

function renderKBArticle(id) {
  const a = KB_ARTICLES.find(x => x.id === id);
  if (!a) { KB_SELECTED = null; return renderKB(); }
  const admin = window.isAdmin();
  const views = getKBViews(id);
  const votes = getKBNetVote(id);
  const userVote = getKBUserVote(id);
  const reading = readingTime(a.body);
  const wordCount = (a.body || '').split(/\s+/).filter(Boolean).length;
  const related = getRelatedArticles(a);
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span data-action="kb.close">Knowledge Base</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${a.id}</span>
          ${admin ? `<span style="margin-left:auto;display:flex;gap:6px">
            <button class="btn btn-sm" data-action="kb.toggleFeatured" data-id="${window.escAttr(a.id)}">${a.featured?'★ Unfeature':'☆ Feature'}</button>
            <button class="btn btn-sm" data-action="kb.edit" data-id="${window.escAttr(a.id)}">Edit</button>
            <button class="btn btn-sm btn-danger" data-action="kb.delete" data-id="${window.escAttr(a.id)}">Delete</button>
          </span>` : ''}
        </div>
      </div>
      <div class="page-scroll">
        <div class="kb-article">
          <div class="kb-card-cat" style="display:flex;align-items:center;gap:8px">
            <span>${a.category}</span>
            ${a.featured ? '<span style="color:var(--amber);font-weight:600">★ Featured</span>' : ''}
          </div>
          <h1 class="kb-article-h">${a.title}</h1>
          <div class="kb-article-meta">
            <span>${a.id}</span>
            <span>By ${a.author}</span>
            <span>Updated ${a.updated}</span>
            <span>${views} view${views===1?'':'s'}</span>
            <span>${reading} min read · ${wordCount} words</span>
            ${votes !== 0 ? `<span style="color:${votes>0?'var(--green)':'var(--red)'}">${votes>0?'+':''}${votes} helpful</span>` : ''}
          </div>
          <div class="ai-md">${renderMarkdown(a.body)}</div>

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
                  <div class="kb-card-cat" style="margin-bottom:6px">${r.category}</div>
                  <div class="kb-card-t" style="font-size:13px">${r.title}</div>
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
  window.renderPage('kb');
  // restore focus to the input that had it
  const input = document.querySelector('.filter-bar input');
  if (input && wasFocused?.tagName === 'INPUT') {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}
function kbSetCat(c) { KB_FILTER_CAT = c; window.renderPage('kb'); }
function openKBArticle(id) { incrementKBView(id); KB_SELECTED = id; window.renderPage('kb'); }
function closeKBArticle()  { KB_SELECTED = null; window.renderPage('kb'); }

function kbArticleForm(initial) {
  const cats = [...new Set(KB_ARTICLES.map(a => a.category))];
  const a = initial || {title:'', category:cats[0]||'Getting Started', body:''};
  return `
    <div class="form-row"><label class="form-label">Title</label><input class="form-input" id="kb-title" value="${a.title.replace(/"/g,'&quot;')}"/></div>
    <div class="form-row"><label class="form-label">Category</label>
      <input class="form-input" id="kb-cat" list="kb-cat-list" value="${a.category.replace(/"/g,'&quot;')}"/>
      <datalist id="kb-cat-list">${cats.map(c => `<option value="${c}">`).join('')}</datalist>
    </div>
    <div class="form-row"><label class="form-label">Body</label><textarea class="form-input" id="kb-body" style="min-height:240px;font-family:'Inter',sans-serif">${a.body}</textarea></div>`;
}

function kbNewArticle() {
  if (!window.isAdmin()) return;
  window.showModal('New article', kbArticleForm(null), async () => {
    const title = document.getElementById('kb-title').value.trim();
    const cat   = document.getElementById('kb-cat').value.trim() || 'Getting Started';
    const body  = document.getElementById('kb-body').value;
    if (!title || !body.trim()) return;
    if (kbApiBacked()) {
      let resp;
      try { resp = await apiPost('/api/v1/kb-articles', { title, category: cat, body }); }
      catch (err) { alert(`Couldn't publish: ${err?.message || err}`); return; }
      KB_ARTICLES.unshift(mapKbResponse(resp.article));
    } else {
      const id = 'KB-' + String(KB_ARTICLES.length + 1).padStart(3, '0');
      KB_ARTICLES.unshift({id, title, category:cat, body, author:SESSION?.name||'Unknown', updated:new Date().toISOString().slice(0,10)});
    }
    window.closeModal(); window.renderPage('kb');
  }, 'Publish', true);
}

function kbEditArticle(id) {
  if (!window.isAdmin()) return;
  const a = KB_ARTICLES.find(x => x.id === id); if (!a) return;
  window.showModal('Edit article', kbArticleForm(a), async () => {
    const title = document.getElementById('kb-title').value.trim();
    const cat   = document.getElementById('kb-cat').value.trim() || a.category;
    const body  = document.getElementById('kb-body').value;
    if (!title || !body.trim()) return;
    if (a._uuid) {
      try { await apiPatch(`/api/v1/kb-articles/${a._uuid}`, { title, category: cat, body }); }
      catch (err) { alert(`Couldn't save: ${err?.message || err}`); return; }
    }
    a.title = title; a.category = cat; a.body = body;
    a.updated = new Date().toISOString().slice(0,10);
    window.closeModal(); window.renderPage('kb');
  }, 'Save changes', true);
}

function kbDeleteArticle(id) {
  if (!window.isAdmin()) return;
  const a = KB_ARTICLES.find(x => x.id === id); if (!a) return;
  window.showModal('Delete article', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${a.title}</strong>? This cannot be undone.</div>`, async () => {
    if (a._uuid) {
      try { await apiDelete(`/api/v1/kb-articles/${a._uuid}`); }
      catch (err) { alert(`Couldn't delete: ${err?.message || err}`); return; }
    }
    const i = KB_ARTICLES.findIndex(x => x.id === id);
    if (i >= 0) KB_ARTICLES.splice(i, 1);
    KB_SELECTED = null;
    window.closeModal(); window.renderPage('kb');
  }, 'Delete');
}

registerActions({
  'kb.open':           (ds) => openKBArticle(ds.id),
  'kb.close':          () => closeKBArticle(),
  'kb.new':            () => kbNewArticle(),
  'kb.edit':           (ds) => kbEditArticle(ds.id),
  'kb.delete':         (ds) => kbDeleteArticle(ds.id),
  'kb.toggleFeatured': (ds) => toggleKBFeatured(ds.id),
  'kb.setCat':         (ds) => kbSetCat(ds.cat),
  'kb.vote':           (ds) => voteKB(ds.id, ds.vote),
});

registerInputActions({
  'kb.setQuery': (ds, el) => kbSetQuery(el.value),
});
