import {expect,test} from 'bun:test';
import {replyChangeRatio} from './lib/reply-change.js';
test('text difference normalises case and whitespace and keeps minor edits below the threshold',()=>{
  expect(replyChangeRatio(' Hello   Sam ','hello sam')).toBe(0);
  expect(replyChangeRatio('Hello Sam, your account is ready.','Hello Sam, your account is now ready.')).toBeLessThan(0.3);
  expect(replyChangeRatio('The withdrawal is pending.','Please upload a photo of your passport.')).toBeGreaterThanOrEqual(0.3);
});
test('handles empty, repeated and multilingual text with bounded ratios',()=>{
  expect(replyChangeRatio('','')).toBe(0);expect(replyChangeRatio('a','b')).toBe(1);
  expect(replyChangeRatio('aaaa','bbbb')).toBe(1);
  expect(replyChangeRatio('您的账户已经准备好了','您的账户已经准备好了')).toBe(0);
  const ratio=replyChangeRatio('مرحبا بك','Hello there');expect(ratio).toBeGreaterThanOrEqual(0);expect(ratio).toBeLessThanOrEqual(1);
});
