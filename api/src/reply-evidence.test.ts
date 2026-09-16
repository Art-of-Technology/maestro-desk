import { test,expect } from 'bun:test';
import { knowledgeReference } from './lib/reply-evidence.js';
import { ReplyReview } from './lib/reply-review.js';

test('article evidence uses stored dates and market metadata with actionable warnings',()=>{
  const ref=knowledgeReference({id:'00000000-0000-4000-8000-000000000001',display_id:'KB-1',title:'Policy',
    category:'Website · es-mx',updated_at:new Date('2026-09-01T12:00:00Z'),review_due_date:'2026-09-01',changes_pending:true,error:'Private error'},'2026-09-16');
  expect(ref).toMatchObject({kind:'article',market:'es-mx',datedAt:'2026-09-01T12:00:00.000Z'});
  expect(ref.warnings).toHaveLength(3);
  expect(JSON.stringify(ref)).not.toContain('Private error');
  expect(ReplyReview.safeParse({references:[ref],notes:[]}).success).toBe(true);
  const absent=knowledgeReference({id:ref.entityId,display_id:'KB-2',title:'No metadata'});
  expect(absent.market).toBeUndefined();expect(absent.datedAt).toBeUndefined();expect(absent.warnings).toEqual([]);
});
test('saved evidence accepts old references and rejects invalid metadata',()=>{
  expect(ReplyReview.safeParse({references:[{id:'KB-old',title:'Old reference'}],notes:[]}).success).toBe(true);
  for(const extra of [{entityId:'javascript:bad'},{datedAt:'yesterday'},{warnings:['x'.repeat(301)]},{kind:'verified'}])
    expect(ReplyReview.safeParse({references:[{id:'KB-1',title:'Policy',...extra}],notes:[]}).success).toBe(false);
});
