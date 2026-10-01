import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { attachmentThumbnail } from './attachment-thumbnail.js';

test('thumbnails shrink raster images, orient them, and remove private metadata', async () => {
  const original = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#925ec4' } })
    .withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer();
  const output = await attachmentThumbnail(original);
  const metadata = await sharp(output).metadata();
  expect(metadata.format).toBe('webp');
  expect([metadata.width, metadata.height]).toEqual([80, 80]);
  expect(metadata.exif).toBeUndefined();
  expect(metadata.orientation).toBeUndefined();
  expect(output.length).toBeLessThan(original.length / 10);
  const tiny = await sharp({ create: { width: 12, height: 12, channels: 4, background: '#00000000' } }).png().toBuffer();
  const small = await sharp(await attachmentThumbnail(tiny)).metadata();
  expect([small.width, small.height, small.hasAlpha]).toEqual([12, 12, true]);
  for (const format of ['png', 'webp', 'gif'] as const) {
    const input = await sharp(tiny).toFormat(format).toBuffer();
    expect((await sharp(await attachmentThumbnail(input)).metadata()).format).toBe('webp');
  }
});

test('rejects active content, corrupt images, excessive bytes and excessive pixels', async () => {
  for (const input of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('%PDF-1.7'),
    Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20 * 1024 * 1024 + 1)]) {
    await expect(attachmentThumbnail(input)).rejects.toThrow();
  }
  const oversized = await sharp({ create: { width: 5001, height: 5000, channels: 3, background: 'white' } }).png().toBuffer();
  await expect(attachmentThumbnail(oversized)).rejects.toThrow(/pixel limit/i);
});
