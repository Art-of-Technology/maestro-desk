import { expect, test } from 'bun:test';
import { PostmarkDelivery } from './postmark-delivery.js';

const receipt = {
  RecordType: 'Delivery', MessageStream: 'outbound',
  MessageID: '11111111-1111-4111-8111-111111111111',
  Recipient: 'fixture@example.test', DeliveredAt: '2026-10-23T12:00:00Z',
};

test('delivery metadata accepts string records and defaults missing historical metadata', () => {
  expect(PostmarkDelivery.parse(receipt).Metadata).toEqual({});
  const Metadata = { workspace_id: 'brand', message_id: 'message', send_attempt_id: 'attempt' };
  expect(PostmarkDelivery.parse({ ...receipt, Metadata }).Metadata).toEqual(Metadata);
  for (const value of [null, [], { message_id: 123 }]) {
    expect(PostmarkDelivery.safeParse({ ...receipt, Metadata: value }).success).toBe(false);
  }
});
