import { expect, test } from 'bun:test';
import { parseCustomerReply } from './lib/customer-reply.js';

const sources = [{ id: 'KB-123', title: 'Withdrawal policy', url: 'https://example.com/policy' }];
const valid = { customerReply: 'You can play here: https://www.spacecasino.com/en-ca/games/netent/starburst/123', referenceIds: ['KB-123'], internalNotes: ['Confirm the customer’s market.'] };

test('customer text retains public links while citations and notes remain separate', () => {
  const result = parseCustomerReply(valid, sources);
  expect(result.text).toBe(valid.customerReply);
  expect(result.text).not.toContain('KB-123');
  expect(result.text).not.toContain(valid.internalNotes[0]);
  expect(result.internal.references).toEqual(sources);
  expect(result.internal.notes).toEqual(valid.internalNotes);
});

test('rejects labels, internal citations, invalid shapes and invented reference IDs', () => {
  for (const customerReply of ['Draft: Hello', 'Draft\nHello', '**Draft reply**: Hello', 'According to our knowledge base, wait.', 'Hello [KB-123]', 'Hello [Withdrawal policy]']) {
    expect(() => parseCustomerReply({ ...valid, customerReply }, sources)).toThrow();
  }
  expect(() => parseCustomerReply('Draft: raw model response', sources)).toThrow();
  expect(() => parseCustomerReply({ ...valid, referenceIds: ['KB-foreign'] }, sources)).toThrow();
  expect(() => parseCustomerReply({ ...valid, internalNotes: 'not an array' }, sources)).toThrow();
  expect(parseCustomerReply({ ...valid, customerReply: 'Your bank draft has been received.' }, sources).text).toBe('Your bank draft has been received.');
});

test('allows internal-only review results without manufacturing an email', () => {
  expect(parseCustomerReply({ ...valid, customerReply: '' }, sources).text).toBe('');
  expect(() => parseCustomerReply({ customerReply: '', internalNotes: [], referenceIds: [] }, [])).toThrow();
});
