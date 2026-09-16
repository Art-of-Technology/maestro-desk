import { apiGet, apiPost, apiPatch, getWorkspaceId, getJwt } from '../core/api-client.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { showModal, closeModal } from '../core/modal.js';
import { formatRoute } from '../core/route-location.js';
import { setKbSelected } from '../core/state.js';
import { renderPage } from '../core/router.js';

const states = {open:'Open',in_progress:'Article work in progress',resolved:'Resolved',dismissed:'Dismissed'};
const signals = {unanswered:'Unanswered at scan',negative_feedback:'Negative suggestion feedback',both:'Unanswered and negative feedback'};
const esc = value => window.escHtml(String(value??''));
const attr = value => window.escAttr(String(value??''));
const scope = () => JSON.stringify([getWorkspaceId(),getJwt()]);
let view = null;
const active = v => view===v && v.scope===scope() && window.isAdmin() && document.getElementById('kb-gaps-content')===v.host;

export function gapCards(items,workspace) {
  return items.map(item => `<article class="reply-feedback-card" data-gap-id="${attr(item.id)}">
    <h3>${esc(item.category||'Uncategorised')}</h3><p>Brand: ${esc(item.brand||'Not recorded')} · Market: ${esc(item.market||'Not recorded')}</p>
    <p>Last scanned ${esc(new Date(item.scanned_at).toLocaleString())}. Up to 20 linked tickets are shown.</p>
    ${item.tickets.length<2?'<p>Fewer than two matching tickets remain. Review whether this is still a useful lead.</p>':''}
    <ul style="padding-left:18px">${item.tickets.map(t=>`<li><a target="_blank" rel="noopener noreferrer" href="${attr(formatRoute({workspaceId:workspace,page:'tickets',entityId:t.id}))}">${esc(t.display_id)} · ${esc(t.subject)}</a> — ${esc(signals[t.signal])}</li>`).join('')}</ul>
    ${item.article_display_id?`<p>Linked article: <button class="btn btn-sm" data-action="kbGaps.article" data-id="${attr(item.article_display_id)}">${esc(item.article_display_id)} · ${esc(item.article_title)}</button> (${esc(item.article_status)})</p>`:''}
    <div class="form-grid" style="margin-top:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))">
      <label class="form-row">Work status<select name="state" class="form-input">${Object.entries(states).map(([key,label])=>`<option value="${key}" ${item.state===key?'selected':''}>${label}</option>`).join('')}</select></label>
      <label class="form-row">Article ID<input name="article" class="form-input" maxlength="80" value="${attr(item.article_display_id||'')}" placeholder="KB-…"></label>
    </div><label class="form-row">Investigation / article notes<textarea name="note" class="form-input" maxlength="2000" rows="3">${esc(item.note)}</textarea></label>
    <button class="btn btn-solid" data-action="kbGaps.save" data-id="${attr(item.id)}" data-version="${item.version}">Save work status</button>
  </article>`).join('');
}

function render(v) {
  if (!active(v)) return;
  v.host.innerHTML = `<p>Potential gaps need review. Scans group at least two unanswered tickets or negatively rated suggestions by ticket category, brand and market. These signals do not prove an article is missing.</p>
    <p>Each scan checks the 500 most recently updated tickets from the last 30 days and retains up to 50 groups. It uses no AI calls. Scan findings can become outdated; open the tickets to verify them.</p>
    <div class="kb-quality-controls"><button class="btn btn-solid" data-action="kbGaps.scan">Scan recent tickets</button><button class="btn" data-action="kbGaps.refresh">Refresh queue</button><button class="btn" data-action="kb.new">Create article</button>
      <label>Work status <select class="form-input" data-change-action="kbGaps.filter">${Object.entries(states).map(([key,label])=>`<option value="${key}" ${key===v.state?'selected':''}>${label}</option>`).join('')}</select></label></div>
    <p>Link an existing article ID when work starts. Check it applies to this brand and market. Saving here does not publish or change an article.</p>
    <p id="kb-gaps-status" role="status">${esc(v.message)}</p>
    ${v.items.length?gapCards(v.items,getWorkspaceId()):'<p>No gaps in this view. Scan recent tickets to look for recurring signals.</p>'}
    <div class="kb-quality-controls">${v.offset?`<button class="btn" data-action="kbGaps.page" data-offset="${v.offset-25}">Previous</button>`:''}${v.hasMore?`<button class="btn" data-action="kbGaps.page" data-offset="${v.offset+25}">Next</button>`:''}</div>`;
}

async function load(v) {
  const data = await apiGet(`/api/v1/knowledge-gaps?state=${v.state}&offset=${v.offset}`);
  if (active(v)) { v.items=data.items; v.hasMore=data.hasMore; }
}

async function run(work) {
  const v=view;
  if (!v || !active(v) || v.busy) return;
  v.busy=true;
  const focused=v.host.contains(document.activeElement)?document.activeElement:null;
  v.host.querySelectorAll('button,input,select,textarea').forEach(el=>{el.disabled=true;});
  try {
    await work(v);
    if (active(v)) {
      render(v);
      if (focused) {
        const target=[...v.host.querySelectorAll('button,select')].find(el=>el.tagName===focused.tagName && JSON.stringify({...el.dataset})===JSON.stringify({...focused.dataset}));
        (target||v.host.querySelector('button'))?.focus();
      }
    }
  } catch (error) {
    if (active(v)) document.getElementById('kb-gaps-status').textContent=error?.status===409
      ? 'This gap changed. Copy your notes, refresh, and try again.' : error?.message||'The queue could not be updated. Try again.';
  } finally {
    v.busy=false;
    if (active(v)) v.host.querySelectorAll('button,input,select,textarea').forEach(el=>{el.disabled=false;});
  }
}

function open() {
  if (!window.isAdmin() || !getJwt() || !getWorkspaceId()) return;
  const trigger=document.activeElement;
  showModal('Knowledge gaps from tickets','<div id="kb-gaps-content"></div>',null,'',true);
  view={scope:scope(),host:document.getElementById('kb-gaps-content'),state:'open',offset:0,items:[],hasMore:false,busy:false,message:''};
  const modal=view.host.closest('.modal');
  modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true'); modal.setAttribute('aria-label','Knowledge gaps from tickets'); modal.tabIndex=-1;
  const close=modal.querySelector('.modal-close'); close.setAttribute('role','button'); close.setAttribute('aria-label','Close knowledge gaps'); close.tabIndex=0;
  modal.addEventListener('keydown',event=>{
    if (event.key==='Escape'||(event.target===close&&['Enter',' '].includes(event.key))) { event.preventDefault(); closeModal(); trigger?.focus(); return; }
    if (event.key!=='Tab') return;
    const nodes=[...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')];
    if (event.shiftKey && [nodes[0],modal].includes(document.activeElement)) {event.preventDefault();nodes.at(-1)?.focus();}
    else if (!event.shiftKey && document.activeElement===nodes.at(-1)) {event.preventDefault();nodes[0]?.focus();}
  });
  render(view); modal.focus(); void run(load);
}

registerActions({
  'kbGaps.show':open,
  'kbGaps.refresh':()=>run(load),
  'kbGaps.scan':()=>run(async v=>{
    const result=await apiPost('/api/v1/knowledge-gaps/scan',{});
    if (!active(v)) return;
    v.offset=0; await load(v);
    v.message=`Scanned ${result.scanned} recent tickets; found ${result.groups} recurring groups.${result.limited?' Scan limit reached; this is a partial view.':''}`;
  }),
  'kbGaps.page':ds=>run(async v=>{v.offset=Number(ds.offset)||0;await load(v);}),
  'kbGaps.save':(ds,button)=>{
    const card=button.closest('[data-gap-id]');
    const body={state:card.querySelector('[name="state"]').value,article_display_id:card.querySelector('[name="article"]').value.trim(),note:card.querySelector('[name="note"]').value.trim(),version:Number(ds.version)};
    return run(async v=>{await apiPatch('/api/v1/knowledge-gaps/'+encodeURIComponent(ds.id),body);await load(v);v.message='Work status saved.';});
  },
  'kbGaps.article':ds=>{if(view&&active(view)&&!view.busy){closeModal();setKbSelected(ds.id);renderPage('kb');}},
});
registerChangeActions({'kbGaps.filter':(_ds,el)=>run(async v=>{v.state=el.value;v.offset=0;await load(v);})});
