import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../web/js/tickets/attachments.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,'');
test('uploads join the current draft, remain local if sync fails, and cannot cross workspace switches',async()=>{
  let workspace='a',files=[],release,failSync=true;
  const messages=[],file={id:'file',filename:'receipt.pdf'};
  const context={TICKETS:[{id:'TK-1',_uuid:'ticket'}],COMPOSE_TAB:'reply',
    getWorkspaceId:()=>workspace,getJwt:()=>'session',loadDraftAttachments:()=>files,
    saveDraftAttachments:(_id,value)=>{files=value;},flushPersonalDraft:async()=>{if(failSync)throw Error('Offline');},draftSending:()=>false,
    apiUpload:async()=>{if(release!==null)await new Promise(resolve=>{release=resolve;});return {attachment:file};},
    document:{getElementById:()=>null},FormData:class{append(){}},registerActions(){},showToast:text=>messages.push(text),
  };
  const att=runInNewContext(source+'\n({uploadFiles,attachmentsUploading,pendingAttachmentIds})',context);
  const upload=att.uploadFiles('TK-1',[{name:'receipt.pdf'}]);expect(att.attachmentsUploading('TK-1')).toBe(true);
  release();await upload;expect(att.pendingAttachmentIds('TK-1')).toEqual(['file']);
  expect(messages.join(' ')).toContain('not synced');expect(att.attachmentsUploading('TK-1')).toBe(false);
  const late=att.uploadFiles('TK-1',[{name:'receipt.pdf'}]);workspace='b';files=[];release();await late;
  expect(files).toEqual([]);expect(att.attachmentsUploading('TK-1')).toBe(false);
});

const previewSource=readFileSync(new URL('../web/js/tickets/attachment-preview.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,'');
test('preview renders only supported content, revokes object URLs, and ignores late responses after closing',async()=>{
  let dialog,mime='application/pdf',hold,release;
  const revoked=[];
  class Element {
    constructor(tag){this.tag=tag;this.events={};this.children=[];this.hidden=true;}
    setAttribute(){} addEventListener(name,fn){this.events[name]=fn;}
    replaceChildren(...children){this.children=children;}
    querySelector(selector){return this.parts[selector];}
    set innerHTML(_value){this.parts={'[data-close]':new Element('button'),'.attachment-preview-body':new Element('div'),a:new Element('a')};}
    showModal(){this.open=true;}close(){this.open=false;this.events.close?.();}remove(){}
  }
  const context={getWorkspaceId:()=>'a',getJwt:()=>'session',registerActions(){},AbortController,encodeURIComponent,
    URL:{createObjectURL:()=>'blob:test',revokeObjectURL:url=>revoked.push(url)},
    window:{escHtml:v=>v,addEventListener(){},removeEventListener(){}},
    document:{activeElement:null,body:{appendChild(el){dialog=el;}},createElement:tag=>new Element(tag)},
    apiGet:async()=>{if(hold)await hold;return {type:mime};},
  };
  const preview=runInNewContext(previewSource+'\npreviewAttachment',context);
  await preview({ticketUuid:'ticket',attId:'file',filename:'receipt.pdf'});
  expect(dialog.parts['.attachment-preview-body'].children[0].tag).toBe('iframe');
  expect(dialog.parts.a.download).toBe('receipt.pdf');dialog.close();expect(revoked).toEqual(['blob:test']);
  mime='image/png';await preview({ticketUuid:'ticket',attId:'image'});
  expect(dialog.parts['.attachment-preview-body'].children[0].tag).toBe('img');dialog.close();
  mime='text/html';await preview({ticketUuid:'ticket',attId:'html'});
  expect(dialog.parts['.attachment-preview-body'].textContent).toContain('not available');dialog.close();
  hold=new Promise(resolve=>{release=resolve;});const pending=preview({ticketUuid:'ticket',attId:'late'});
  const closed=dialog;closed.close();release();await pending;expect(closed.parts.a.hidden).toBe(true);
});

const thumbnailSource=readFileSync(new URL('../web/js/tickets/attachment-thumbnails.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,'');
test('thumbnails are lazy, share requests, reuse rendered files, and release them on scope changes',async()=>{
  let observer,workspace='first',requests=0,created=0,release;
  const revoked=[],events={},controllers=[];
  const target=id=>({dataset:{imageThumb:id},isConnected:true,textContent:'IMG',replaceChildren(img){this.img=img;}});
  const a=target('image'),b=target('image');let nodes=[a,b];
  const root={querySelectorAll:()=>nodes};
  const context={getWorkspaceId:()=>workspace,getJwt:()=>'session',AbortController,encodeURIComponent,
    window:{escAttr:v=>v,escHtml:v=>v,addEventListener:(name,fn)=>{events[name]=fn;}},
    URL:{createObjectURL:()=>`blob:${++created}`,revokeObjectURL:url=>revoked.push(url)},
    document:{createElement:()=>({addEventListener(){}})},
    IntersectionObserver:class{constructor(fn){this.callback=fn;observer=this;}observe(){}unobserve(){}disconnect(){}},
    apiGet:async(path,options)=>{expect(path).toEndWith('/content?thumbnail=1');requests++;controllers.push(options.signal);if(release!==null)await new Promise(resolve=>{release=resolve;});return {type:'image/webp'};},
  };
  const thumbnails=runInNewContext(thumbnailSource+'\n({mountAttachmentThumbnails,resetAttachmentThumbnails,attachmentBadge})',context);
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  thumbnails.mountAttachmentThumbnails(root,'ticket');expect(requests).toBe(0);
  observer.callback([{target:a,isIntersecting:false}]);expect(requests).toBe(0);
  observer.callback([{target:a,isIntersecting:true},{target:b,isIntersecting:true}]);expect(requests).toBe(1);
  release();await settle();expect(a.img.src).toBe('blob:1');expect(b.img.src).toBe('blob:1');
  const redraw=target('image');nodes=[redraw];thumbnails.mountAttachmentThumbnails(root,'ticket');
  observer.callback([{target:redraw,isIntersecting:true}]);await settle();expect(requests).toBe(1);expect(redraw.img.src).toBe('blob:1');
  workspace='second';events['respovia:auth-scope-changed']();expect(revoked).toEqual(['blob:1']);expect(redraw.textContent).toBe('IMG');
  thumbnails.mountAttachmentThumbnails(root,'ticket');observer.callback([{target:redraw,isIntersecting:true}]);
  thumbnails.resetAttachmentThumbnails();expect(controllers.at(-1).aborted).toBe(true);release();await settle();expect(created).toBe(1);
  expect(thumbnails.attachmentBadge({filename:'receipt.pdf',mime_type:'application/pdf'},'ticket')).toContain('>PDF</span>');
});

test('missing files and unsafe content retain a readable badge without breaking previews',async()=>{
  let observer,fail=true;
  const node={dataset:{imageThumb:'file'},isConnected:true,textContent:'IMG',replaceChildren(){throw Error('Unsafe image rendered');}};
  const context={getWorkspaceId:()=>'workspace',getJwt:()=>'session',AbortController,encodeURIComponent,
    window:{addEventListener(){},escAttr:v=>String(v).replaceAll('"','&quot;'),escHtml:v=>v},
    URL:{createObjectURL(){throw Error('Unsafe blob URL');},revokeObjectURL(){}},document:{},
    IntersectionObserver:class{constructor(fn){observer=fn;}observe(){}unobserve(){}disconnect(){}},
    apiGet:async()=>{if(fail)throw Error('Not found');return {type:'text/html'};},
  };
  const thumbnails=runInNewContext(thumbnailSource+'\n({mountAttachmentThumbnails,resetAttachmentThumbnails,attachmentBadge})',context);
  for (const ticket of ['first','second']) {
    thumbnails.mountAttachmentThumbnails({querySelectorAll:()=>[node]},ticket);
    observer([{target:node,isIntersecting:true}]);await new Promise(resolve=>setImmediate(resolve));
    expect(node.textContent).toBe('IMG');expect(node.title).toContain('unavailable');fail=false;
  }
  expect(thumbnails.attachmentBadge({id:'" onclick="bad()',filename:'unsafe.svg',mime_type:'image/svg+xml'},'ticket')).not.toContain('data-image-thumb');
  expect(thumbnails.attachmentBadge({id:'" onclick="bad()',filename:'image.png',mime_type:'image/png'},'ticket')).toContain('&quot;');
  thumbnails.resetAttachmentThumbnails();
});
