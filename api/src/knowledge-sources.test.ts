import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { knowledgeTerms, selectKnowledgePassages } from './lib/knowledge-context.js';
import { canonicalKnowledgeUrl } from './lib/knowledge-import.js';

describe('knowledge selection and URL boundaries',()=>{
  it('keeps page labels and finds relevant text late in a document',()=>{
    const body='## Page 1\n'+('Unrelated text. '.repeat(700))+'\n## Page 9\nWithdrawal processing takes 24 hours after approval.';
    const result=selectKnowledgePassages(body,'withdrawal processing approval');
    expect(result).toContain('Page 9');expect(result).toContain('24 hours');expect(result.length).toBeLessThanOrEqual(6000);
  });
  it('normalizes anchors and rejects credentials, non-HTTPS and custom ports',()=>{
    expect(canonicalKnowledgeUrl('https://example.com/policy#withdraw')).toBe('https://example.com/policy');
    for(const u of ['file:///etc/passwd','http://example.com','https://u:p@example.com','https://example.com:8080'])expect(()=>canonicalKnowledgeUrl(u)).toThrow();
    expect(knowledgeTerms('withdrawal | ! <script>')).toEqual(['withdrawal','script']);
  });
});

const db=process.env.RUN_DB_TESTS?describe:describe.skip;
type SourceDetail = { versions: { id: string }[]; source: { error: string | null; approved_version_id: string | null } };
db('knowledge source lifecycle and isolation',()=>{
  let app:typeof import('./index.js').default, sql:ReturnType<typeof import('./lib/db.js').getDb>;
  let ws:string, other:string, user:string, token:string, memberToken:string, memberId:string,sourceId:string;
  const request=(path:string,method='GET',body?:unknown,workspace?:string,tok?:string)=>app.request('/api/v1/knowledge-sources'+path,{
    method,headers:{Authorization:`Bearer ${tok||token}`,'X-Workspace-Id':workspace||ws,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),
  });
  beforeAll(async()=>{
    app=(await import('./index.js')).default;sql=(await import('./lib/db.js')).getDb();
    const {auth}=await import('./lib/auth.js');const run=crypto.randomUUID();
    const signed=await auth.api.signUpEmail({body:{email:`kb-${run}@t.test`,password:'test-password-12345',name:'Knowledge test'}});
    user=signed.user.id;token=signed.token!;
    const member=await auth.api.signUpEmail({body:{email:`kb-member-${run}@t.test`,password:'test-password-12345',name:'Member'}});
    memberId=member.user.id;memberToken=member.token!;
    const [a]=await sql`select provision_brand(${'kb-a-'+run},'KB A') as id`;ws=a.id;
    const [b]=await sql`select provision_brand(${'kb-b-'+run},'KB B') as id`;other=b.id;
    for(const id of [ws,other]) {
      const [role]=await sql`select id from roles where workspace_id=${id} and name='Admin'`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${id},${user},${role.id},true)`;
    }
    const [role]=await sql`select id from roles where workspace_id=${ws} and name<>'Admin' limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${ws},${memberId},${role.id},true)`;
    const [s]=await sql`insert into knowledge_sources(workspace_id,kind,title,locator,fingerprint,created_by)
      values(${ws},'url','Withdrawal rules','https://example.com/withdraw','test',${user}) returning id`;sourceId=s.id;
  },30000);
  beforeEach(async()=>{await sql`delete from rate_limit_hits where bucket=${'knowledge-import:'+ws}`;});
  afterAll(async()=>{
    if(ws)await sql`delete from workspaces where id in (${ws},${other})`;
    if(user)await sql`delete from users where id in (${user},${memberId})`;
  });
  it('stores and deduplicates versions; only explicit publication exposes the body to AI',async()=>{
    const {saveKnowledgeVersion}=await import('./lib/knowledge-sources.js');
    const {publishedKnowledgeContext}=await import('./lib/knowledge-context.js');
    await saveKnowledgeVersion(ws,sourceId,{body:'## Page 2\nWithdrawals process within 24 hours of approval.',warnings:[]});
    await saveKnowledgeVersion(ws,sourceId,{body:'## Page 2\nWithdrawals process within 24 hours of approval.',warnings:[]});
    let detail=await (await request('/'+sourceId)).json() as SourceDetail;expect(detail.versions).toHaveLength(1);
    expect(await publishedKnowledgeContext(ws,'withdrawal')).not.toContain('24 hours');
    expect((await request('/'+sourceId+'/publish','POST',{version_id:detail.versions[0].id})).status).toBe(200);
    expect(await publishedKnowledgeContext(ws,'withdrawal')).toContain('24 hours');
    expect(await publishedKnowledgeContext(other,'withdrawal')).not.toContain('24 hours');
    await saveKnowledgeVersion(ws,sourceId,{body:'## Page 2\nProcessing takes 48 hours.',warnings:[]});
    detail=await (await request('/'+sourceId)).json() as SourceDetail;expect(detail.versions).toHaveLength(2);
    expect(await publishedKnowledgeContext(ws,'withdrawal')).toContain('24 hours');
    expect(await publishedKnowledgeContext(ws,'withdrawal')).toContain('"changesPending":true');
    const [a]=await sql`select count(*)::int as n from kb_articles where workspace_id=${ws} and title='Withdrawal rules'`;expect(a.n).toBe(1);
  });
  it('rejects foreign source IDs and ordinary members',async()=>{
    for(const path of ['/'+sourceId,'/'+sourceId+'/download'])expect((await request(path,'GET',undefined,other)).status).toBe(404);
    expect((await request('','GET',undefined,ws,memberToken)).status).toBe(403);
    const detail=await (await request('/'+sourceId)).json() as SourceDetail;
    expect((await request('/'+sourceId+'/publish','POST',{version_id:detail.versions[0].id},other)).status).toBe(404);
  });
  it('failed refresh retains published content and records failure',async()=>{
    await sql`update knowledge_sources set locator='https://127.0.0.1/private' where id=${sourceId}`;
    expect((await request('/'+sourceId+'/refresh','POST',{})).status).toBe(422);
    const detail=await (await request('/'+sourceId)).json() as SourceDetail;expect(detail.source.error).toBeTruthy();expect(detail.source.approved_version_id).toBeTruthy();
  });
  it('deletion is tenant scoped and enqueues private file cleanup',async()=>{
    const [f]=await sql`insert into knowledge_sources(workspace_id,kind,title,locator,fingerprint,storage_key)
      values(${ws},'file','File','file.pdf','test-file',${'knowledge/'+ws+'/fixture/file.pdf'}) returning id,storage_key`;
    await request('/'+f.id,'DELETE',undefined,other);
    expect((await request('/'+f.id)).status).toBe(200);
    expect((await request('/'+f.id,'DELETE')).status).toBe(204);
    const [queued]=await sql`select storage_key from pending_object_deletions where storage_key=${f.storage_key}`;expect(queued.storage_key).toBe(f.storage_key);
    await sql`delete from pending_object_deletions where storage_key=${f.storage_key}`;
  });
  it('uploads privately, previews without publishing, and deduplicates the same file',async()=>{
    const r2=await import('./lib/r2.js');
    const extraction=await import('./lib/knowledge-import.js');
    const stored=new Map<string,Uint8Array>();
    const store=spyOn(r2,'attachmentsStore').mockReturnValue({
      putObject:async(key,bytes,options)=>{expect(options.contentType).toBe('application/octet-stream');expect(options.contentDisposition).toContain('attachment');stored.set(key,bytes);},
      getObject:async key=>({bytes:stored.get(key)!,contentType:'application/octet-stream'}),
      deleteKeys:async()=>{},listKeys:async()=>[],presignGet:async()=> 'https://example.com/private-download',
    });
    const parse=spyOn(extraction,'extractKnowledge').mockResolvedValue({body:'## Page 1\nSynthetic policy for upload test.',warnings:[]});
    let uploadedId:string|undefined;
    try {
      const upload=()=>{
        const form=new FormData();
        for(const [key,value] of Object.entries({title:'Uploaded policy',category:'Withdrawals',language:'en',jurisdiction:'Test'}))form.set(key,value);
        form.set('file',new File(['%PDF-1.4 synthetic fixture'],'policy.pdf',{type:'application/pdf'}));
        return app.request('/api/v1/knowledge-sources',{method:'POST',headers:{Authorization:`Bearer ${token}`,'X-Workspace-Id':ws},body:form});
      };
      const res=await upload();expect(res.status).toBe(201);
      const result=await res.json() as {source:{id:string}};uploadedId=result.source.id;
      const detail=await (await request('/'+uploadedId)).json() as SourceDetail;
      expect(detail.versions).toHaveLength(1);expect(detail.source.approved_version_id).toBeNull();
      expect((await (await upload()).json() as {duplicate:boolean}).duplicate).toBe(true);
      expect(stored.size).toBe(1);expect(parse).toHaveBeenCalledTimes(1);
      expect([...stored.keys()][0]).toStartWith('knowledge/'+ws+'/');
    } finally {
      store.mockRestore();parse.mockRestore();
      if(uploadedId)await request('/'+uploadedId,'DELETE');
      for(const key of stored.keys())await sql`delete from pending_object_deletions where storage_key=${key}`;
    }
  });
});
