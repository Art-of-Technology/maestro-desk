import { apiGet, apiPost, apiPatch, getWorkspaceId, getJwt } from '../core/api-client.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { showModal, closeModal } from '../core/modal.js';
import { setKbSelected } from '../core/state.js';
import { renderPage } from '../core/router.js';

const labels={thin:'Thin content',duplicate:'Exact duplicates',promotion:'Past promotion dates',overdue:'Overdue reviews',links:'Links to check',broken_links:'Broken links',unverified_links:'Unverified links'};
let view=null;
const scope=()=>JSON.stringify([getWorkspaceId(),getJwt()]);
const active=v=>view===v && v.scope===scope() && document.getElementById('kb-quality-content')===v.host;
const esc=value=>window.escHtml(String(value??''));
const attr=value=>window.escAttr(String(value??''));

function render(v) {
  if(!active(v))return;
  const disabled=v.busy?'disabled':'';
  v.host.innerHTML=`<p>Flags are prompts for review. Reviewing or dismissing a flag does not edit or publish an article. Scan again after content changes.</p>
    <div class="kb-quality-controls">
      <button class="btn btn-solid" data-action="kbQuality.scan" ${disabled}>${v.cursor?'Continue scan':'Scan articles'}</button>
      <button class="btn" data-action="kbQuality.refresh" ${disabled}>Refresh queue</button>
      <label>State<select class="form-input" data-change-action="kbQuality.state" ${disabled}>${['open','reviewed','dismissed'].map(s=>`<option value="${s}" ${v.state===s?'selected':''}>${s[0].toUpperCase()+s.slice(1)}</option>`).join('')}</select></label>
      <label>Flag<select class="form-input" data-change-action="kbQuality.kind" ${disabled}><option value="">All flags</option>${Object.entries(labels).map(([key,label])=>`<option value="${key}" ${v.kind===key?'selected':''}>${label}</option>`).join('')}</select></label>
    </div>
    <p role="status">${esc(v.message)}</p>
    <div class="kb-quality-items">${v.items.length?v.items.map(item=>{
      const links=v.links[item.article_id];
      return `<article class="kb-quality-item"><h3>${esc(labels[item.kind])} · ${esc(item.title)}</h3>
        <p>${esc(item.detail)}</p><p class="kb-form-note">${esc(item.display_id)} · ${esc(item.category)} · Owner: ${esc(item.owner_name||'Unassigned')} · Detected ${esc(item.detected_at.slice(0,10))}</p>
        ${item.stale?'<p class="kb-review-overdue">Article changed since this scan. Scan articles again to refresh its flags.</p>':''}
        <button class="btn" data-action="kbQuality.openArticle" data-display-id="${attr(item.display_id)}" ${disabled}>Open article</button>
        ${['links','broken_links','unverified_links'].includes(item.kind)?`<button class="btn" data-action="kbQuality.links" data-article-id="${attr(item.article_id)}" ${disabled||item.stale?'disabled':''}>${links?.next!=null?'Check next links':'Check links'}</button>`:''}
        ${links?`<p>${links.next!=null?'More links remain to check.':'Last link batch checked.'} Checks are limited to three public HTTPS links per batch.</p><ul>${links.results.map(result=>`<li>${esc(result.url)} — ${result.result==='ok'?'Reachable':result.result==='broken'?'Broken — HTTP 404 or 410':'Could not verify'}</li>`).join('')}</ul>`:''}
        <label for="quality-note-${attr(item.id)}">Review note</label><textarea class="form-input" id="quality-note-${attr(item.id)}" maxlength="1000" ${disabled||item.stale?'disabled':''}>${esc(item.note)}</textarea>
        <div class="kb-quality-controls">${(v.state==='open'?['reviewed','dismissed']:['open']).map(state=>`<button class="btn" data-action="kbQuality.resolve" data-id="${attr(item.id)}" data-state="${state}" ${disabled||item.stale?'disabled':''}>${state==='reviewed'?'Mark reviewed':state==='dismissed'?'Dismiss flag':'Reopen flag'}</button>`).join('')}</div>
        ${item.reviewed_at?`<p class="kb-form-note">Last review action ${esc(item.reviewed_at.slice(0,10))}</p>`:''}</article>`;
    }).join(''):'<p>No flags in this view. Run a scan to check the current articles.</p>'}</div>
    <div class="kb-quality-controls"><button class="btn" data-action="kbQuality.page" data-offset="${Math.max(0,v.offset-50)}" ${disabled||!v.offset?'disabled':''}>Previous</button><span>Page ${Math.floor(v.offset/50)+1}</span><button class="btn" data-action="kbQuality.page" data-offset="${v.offset+50}" ${disabled||!v.hasMore?'disabled':''}>Next</button></div>`;
}
async function load(v) {
  const result=await apiGet('/api/v1/kb-quality?'+new URLSearchParams({state:v.state,offset:String(v.offset),...(v.kind?{kind:v.kind}:{})}));
  if(active(v)){v.items=result.items;v.hasMore=result.hasMore;}
}
async function run(work) {
  const v=view;if(!v||!active(v)||v.busy)return;
  const focused=v.host.contains?.(document.activeElement)?document.activeElement:null;
  v.busy=true;v.message='Working…';render(v);
  if(focused)v.host.closest?.('.modal')?.focus();
  try {await work(v);}catch(error){if(active(v))v.message=error?.message||'Could not update the quality queue. Try again.';}
  finally{if(active(v)){
    v.busy=false;render(v);
    if(focused){
      const target=[...v.host.querySelectorAll('button:not(:disabled),select:not(:disabled),textarea:not(:disabled)')].find(node=>
        node.tagName===focused.tagName && node.id===focused.id && JSON.stringify({...node.dataset})===JSON.stringify({...focused.dataset}));
      (target||v.host.querySelector('[data-action="kbQuality.scan"]'))?.focus();
    }
  }}
}
function open() {
  if(!window.isAdmin()||!getJwt())return;
  const trigger=document.activeElement;
  showModal('Knowledge quality queue','<div id="kb-quality-content"></div>',null,'',true);
  view={scope:scope(),host:document.getElementById('kb-quality-content'),state:'open',kind:'',offset:0,items:[],hasMore:false,busy:false,message:'',cursor:null,scanned:0,links:{}};
  const modal=view.host.closest?.('.modal');
  if(modal){
    modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-label','Knowledge quality queue');modal.tabIndex=-1;
    const close=modal.querySelector('.modal-close');close.setAttribute('role','button');close.setAttribute('aria-label','Close quality queue');close.tabIndex=0;
    const dismiss=()=>{closeModal();trigger?.focus?.();};
    modal.addEventListener('keydown',event=>{
      if(event.key==='Escape'||(event.target===close && ['Enter',' '].includes(event.key))){event.preventDefault();dismiss();return;}
      if(event.key!=='Tab')return;
      const nodes=[...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')];
      const first=nodes[0],last=nodes.at(-1);
      if(event.shiftKey && (document.activeElement===first||document.activeElement===modal)){event.preventDefault();last?.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
    });
    modal.focus();
  }
  void run(async v=>{await load(v);v.message='Scan current articles to find new flags. Scans check up to 1000 articles at a time.';});
}
registerActions({
  'kbQuality.show':open,
  'kbQuality.refresh':()=>run(async v=>{await load(v);v.message='Queue refreshed.';}),
  'kbQuality.scan':()=>run(async v=>{
    if(!v.cursor)v.scanned=0;
    for(let batch=0;batch<20 && active(v);batch++) {
      const result=await apiPost('/api/v1/kb-quality/scan',{after:v.cursor});
      if(!active(v))return;
      v.scanned+=result.scanned;v.cursor=result.next;v.message=`Checked ${v.scanned} articles. Close this window to stop after the current batch.`;render(v);
      if(!v.cursor)break;
    }
    if(!active(v))return;
    v.offset=0;await load(v);v.message=`Checked ${v.scanned} articles. ${v.cursor?'More articles remain. Choose Continue scan.':'Scan complete. Link checks run separately.'}`;
  }),
  'kbQuality.resolve':ds=>{
    const note=document.getElementById('quality-note-'+ds.id)?.value||'';
    return run(async v=>{await apiPatch('/api/v1/kb-quality/'+encodeURIComponent(ds.id),{state:ds.state,note});await load(v);v.message='Review saved.';});
  },
  'kbQuality.links':ds=>run(async v=>{
    const result=await apiPost('/api/v1/kb-quality/'+encodeURIComponent(ds.articleId)+'/check-links',{offset:v.links[ds.articleId]?.next||0});
    if(!active(v))return;
    v.links[ds.articleId]=result;await load(v);v.message='Link check finished. Access restrictions and timeouts are inconclusive.';
  }),
  'kbQuality.page':ds=>run(async v=>{v.offset=Number(ds.offset);await load(v);v.message='';}),
  'kbQuality.openArticle':ds=>{if(view&&active(view)&&!view.busy){closeModal();setKbSelected(ds.displayId);renderPage('kb');}},
});
registerChangeActions({
  'kbQuality.state':(_ds,el)=>run(async v=>{v.state=el.value;v.offset=0;await load(v);v.message='';}),
  'kbQuality.kind':(_ds,el)=>run(async v=>{v.kind=el.value;v.offset=0;await load(v);v.message='';}),
});
