// Run under Node + tsx, matching production; also verifies the bundled font.
import assert from 'node:assert/strict';
import PostalMime from 'postal-mime';
import { unzipSync } from 'fflate';
import { buildEmailDownload } from '../src/lib/email-export.ts';

const email = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ticket_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  role: 'customer', author_label: 'Fixture', body: 'Hello, María — €25', body_html: '<p>Hello, María — €25</p>',
  external_message_id: '<fixture@example.test>', email_metadata: { status: 'received', from: 'a@example.test', to: ['b@example.test'] },
  created_at: '2026-10-01T10:00:00Z', subject: 'Runtime test', merged_from_id: null,
};
const noFile = async () => { throw new Error('Unexpected file access'); };
const pdf = await buildEmailDownload([email], [], 'pdf', true, noFile);
assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), '%PDF-');
const eml = await buildEmailDownload([email], [], 'eml', true, noFile);
const parsed = await PostalMime.parse(eml);
assert.equal(parsed.text.trim(), email.body);
assert.equal(parsed.messageId, email.external_message_id);
const zip = await buildEmailDownload([email], [], 'eml', false, noFile);
assert.equal(Object.keys(unzipSync(zip)).length, 1);
console.log('Node email export runtime: PDF font, EML content and ZIP passed.');
