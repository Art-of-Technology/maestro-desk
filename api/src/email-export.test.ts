import { describe, expect, it } from 'bun:test';
import PostalMime from 'postal-mime';
import { unzipSync } from 'fflate';
import { buildEmailDownload, chronologicalEmails, isExportableEmail, MAX_EXPORT_BYTES, type ExportEmail, type ExportAttachment } from './lib/email-export.js';

const mail = (overrides: Partial<ExportEmail> = {}): ExportEmail => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ticket_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  role: 'customer', author_label: 'Customer', body: 'Hello, María — please check my payment. €25',
  body_html: '<p>Hello, María — please check my payment. €25</p>',
  external_message_id: '<original@example.test>', email_metadata: { status: 'received', from: 'María <maria@example.test>',
    to: ['Support <support@example.test>'], cc: ['copy@example.test'], received_at: '2026-10-01T10:00:00Z' },
  created_at: '2026-10-01T10:01:00Z', subject: 'Payment enquiry', merged_from_id: null, ...overrides,
});
const file = (overrides: Partial<ExportAttachment> = {}): ExportAttachment => ({
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', message_id: mail().id, ticket_id: mail().ticket_id,
  filename: 'receipt.txt', size_bytes: 7, mime_type: 'text/plain', is_inline: false,
  content_id: null, disposition: 'attachment', storage_key: 'private-receipt', ...overrides,
});
const unused = async () => { throw new Error('No file reads expected'); };

describe('saved email downloads', () => {
  it('excludes notes, system events, failed/saved replies and unsent AI content', () => {
    for (const role of ['note', 'system']) expect(isExportableEmail(mail({ role }))).toBe(false);
    for (const status of ['saved', 'failed']) expect(isExportableEmail(mail({ role: 'agent', email_metadata: { status } }))).toBe(false);
    expect(isExportableEmail(mail({ role: 'ai', email_metadata: null, external_message_id: null }))).toBe(false);
    expect(isExportableEmail(mail({ role: 'ai', email_metadata: null }))).toBe(true);
    expect(isExportableEmail(mail({ role: 'agent', email_metadata: { status: 'sent' } }))).toBe(true);
  });
  it('orders by saved email date, even when a merge copied the record later', () => {
    const later = mail({ id: 'later', email_metadata: { status: 'received', received_at: '2026-10-02T00:00:00Z' } });
    expect(chronologicalEmails([later, mail({ created_at: '2026-10-05T00:00:00Z' }), mail({ role: 'note' })]).map(m => m.id)).toEqual([mail().id, 'later']);
  });
  it('round trips Unicode, stored headers, HTML, attachments and inline Content-IDs through an independent MIME parser', async () => {
    const inline = file({ is_inline: true, disposition: 'inline', filename: 'image.png', mime_type: 'image/png' });
    const input = mail({ body_html: `<p>Saved HTML</p><img src="cid:${inline.id}"><script>bad()</script>` });
    const bytes = await buildEmailDownload([input], [inline, file({ id: 'other', message_id: 'not-this-email', storage_key: 'forbidden' })], 'eml', true,
      async key => { expect(key).toBe('private-receipt'); return new Uint8Array([1, 2, 3, 4]); });
    const parsed = await PostalMime.parse(bytes);
    expect(parsed.text?.trim()).toBe(input.body);
    expect(parsed.from?.address).toBe('maria@example.test');
    expect(parsed.to?.[0]).toMatchObject({ address: 'support@example.test' });
    expect(parsed.cc?.[0]).toMatchObject({ address: 'copy@example.test' });
    expect(parsed.messageId).toBe(input.external_message_id!);
    expect(new Date(parsed.date!).toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(parsed.html).toContain(`cid:${inline.id}`);
    expect(parsed.html).not.toContain('bad()');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].contentId).toBe(`<${inline.id}>`);
    expect(new Uint8Array(parsed.attachments[0].content as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
  it('creates an ordered ZIP with one readable EML per email, with missing metadata left absent', async () => {
    const messages = [mail(), mail({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', role: 'ai', email_metadata: null })];
    const bytes = await buildEmailDownload(messages, [], 'eml', false, unused);
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(messages.map((m, i) => `${String(i + 1).padStart(3, '0')}-${m.id}.eml`));
    const parsed = await PostalMime.parse(Object.values(files)[1]);
    expect(parsed.from).toBeUndefined();
    expect(parsed.text?.trim()).toBe(messages[1].body);
  });
  it('fails whole download for missing attachments and enforces size limits before fetching', async () => {
    await expect(buildEmailDownload([mail()], [file()], 'eml', true, unused)).rejects.toThrow('No file reads expected');
    await expect(buildEmailDownload([mail()], [file({ size_bytes: MAX_EXPORT_BYTES + 1 })], 'eml', true, unused)).rejects.toThrow('too large');
    await expect(buildEmailDownload(Array(501).fill(mail()), [], 'eml', false, unused)).rejects.toThrow('500');
  });
  it('generates a paginated Unicode PDF without fetching attachments; rejects unsupported characters explicitly', async () => {
    const bytes = await buildEmailDownload([mail(), mail({ body: 'Long message\n'.repeat(160), role: 'agent' })], [file()], 'pdf', false, unused);
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
    if (process.env.EMAIL_EXPORT_FIXTURE) await Bun.write(process.env.EMAIL_EXPORT_FIXTURE, bytes);
    await expect(buildEmailDownload([mail({ body: 'Missing glyph: 🦄' })], [], 'pdf', true, unused)).rejects.toThrow('Choose Email');
  });
});
