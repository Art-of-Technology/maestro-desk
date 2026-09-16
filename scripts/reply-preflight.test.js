import { expect, test } from 'bun:test';
import { replyWarnings } from '../web/js/tickets/reply-preflight.js';

test('name check distinguishes a different greeting from generic and matching greetings', () => {
  expect(replyWarnings({ text: 'Hello Alex, thanks.', customerName: 'Sam' })[0]).toContain('different name');
  for (const text of ['Hi Sam, thanks.', 'Hello there, thanks.', 'Thanks for contacting us.', 'Dear Dr Smith,', 'Dear Mr. Smith,']) {
    expect(replyWarnings({ text, customerName: 'Sam' })).toEqual([]);
  }
  expect(replyWarnings({ text: 'Hola José, gracias.', customerName: 'José' })).toEqual([]);
  for (const text of ['Hello Alex. Thanks.', 'Hi Alex']) {
    expect(replyWarnings({ text, customerName: 'Sam' })[0]).toContain('different name');
  }
});
test('language mismatch and unknown language remain warnings', () => {
  expect(replyWarnings({ text: 'Hello', replyLanguage: 'English', customerLanguage: 'Spanish' })[0]).toContain('English');
  expect(replyWarnings({ text: 'Hola', replyLanguage: 'Spanish', customerLanguage: 'Spanish' })).toEqual([]);
  expect(replyWarnings({ text: 'Hello', customerLanguage: 'Spanish' })[0]).toContain('could not be checked');
});
test('policy checks do not imply that attached evidence proves a claim', () => {
  expect(replyWarnings({ text: 'Your refund is approved within 3 days.', review: { references: [{ kind: 'article' }] } })[0]).toContain('cannot verify');
  expect(replyWarnings({ text: 'Here are the next steps.', review: { references: [{ kind: 'ticket' }] } })[0]).toContain('No knowledge source');
  expect(replyWarnings({ text: 'Here are the next steps.', review: { references: [{ kind: 'article' }] } })).toEqual([]);
});
