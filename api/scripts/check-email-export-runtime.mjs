// Run under Node + tsx, matching production; also verifies the bundled font.
import assert from 'node:assert/strict';
import PostalMime from 'postal-mime';
import { unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
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
// Exercise the actual Chromium/Node runtime, with synthetic mail only.
const attachment = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', message_id: email.id, ticket_id: email.ticket_id,
  filename: 'logo.png', mime_type: 'image/png', is_inline: true, storage_key: 'fixture-logo', size_bytes: 1000 };
const logo = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><rect width="240" height="60" rx="10" fill="#172554"/><circle cx="34" cy="30" r="16" fill="#38bdf8"/><path d="M66 20h148v8H66zm0 15h100v6H66z" fill="white"/></svg>')).png().toBuffer();
const html = `<table style="width:640px;border-collapse:collapse;font-family:Georgia,serif"><tr><td style="padding:24px;background:#e0f2fe">
  <img width="240" height="60" src="cid:${attachment.id}"><h1 style="color:#172554">Your account update</h1></td></tr>
  <tr><td style="padding:24px"><p>Hello, María — €25</p><p><strong>Your payment is complete.</strong></p>
  <p style="font-family:monospace;color:#0369a1">Reference: ABC-123</p><p>日本語 • العربية • 🦄</p></td></tr>
  <tr><td style="padding:24px;background:#172554;color:white">Customer Support<br>Saved email footer</td></tr></table>
  <img alt="External image" src="http://127.0.0.1/private-image.png"><script>throw Error('Must never run')</script>`;
let reads = 0;
const readLogo = async key => { assert.equal(key, attachment.storage_key); reads++; return logo; };
const temp = mkdtempSync(join(tmpdir(), 'email-pdf-'));
try {
  const formatted = await buildEmailDownload([{ ...email, body_html: html },
    { ...email, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', body_html: `<div style="width:1000px;white-space:nowrap">WIDE-START ${'wide text '.repeat(10)} WIDE-END</div>` },
    { ...email, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', body_html: null, body: 'Long email line\n'.repeat(130) + 'FINAL-LINE' }], [attachment], 'pdf', false, readLogo);
  assert.equal(reads, 1);
  const path = join(temp, 'formatted.pdf');
  writeFileSync(path, formatted);
  const text = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
  for (const part of ['Your account update', 'Saved email footer', 'ABC-123', 'External images were not included.', 'WIDE-END', 'FINAL-LINE']) assert.ok(text.includes(part), part);
  assert.ok(!text.includes('Must never run'));
  assert.ok(execFileSync('pdfimages', ['-list', path], { encoding: 'utf8' }).includes('240    60'), 'Inline logo is embedded in PDF');
  assert.ok((await PDFDocument.load(formatted)).getPageCount() >= 5, 'Long thread paginates');
  if (process.env.EMAIL_EXPORT_FIXTURE) writeFileSync(process.env.EMAIL_EXPORT_FIXTURE, formatted);
  const optedIn = await buildEmailDownload([{ ...email, body_html: html }], [attachment], 'pdf', true, readLogo, {remoteImages:true});
  writeFileSync(path, optedIn);
  const optedText = execFileSync('pdftotext', [path, '-'], {encoding:'utf8'});
  assert.ok(optedText.includes('Some external images were unavailable.'), 'Private-network images remain blocked even after opt-in');
  assert.ok(!optedText.includes('External images were not included.'));
  await assert.rejects(buildEmailDownload([{ ...email, body_html: html }], [attachment], 'pdf', true, noFile), /could not be created/);
} finally { rmSync(temp, {recursive:true, force:true}); }
const eml = await buildEmailDownload([email], [], 'eml', true, noFile);
const parsed = await PostalMime.parse(eml);
assert.equal(parsed.text.trim(), email.body);
assert.equal(parsed.messageId, email.external_message_id);
const zip = await buildEmailDownload([email], [], 'eml', false, noFile);
assert.equal(Object.keys(unzipSync(zip)).length, 1);
console.log('Node email export runtime: styled PDF, CID image, remote-image consent/private-address blocking, Unicode, wide/long pagination, EML and ZIP passed.');
