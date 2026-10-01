import { sniffImageMime } from './image-sniff.js';
import { MAX_INBOUND_FILE_BYTES } from './attachment-policy.js';

export async function attachmentThumbnail(bytes: Uint8Array): Promise<Buffer> {
  if (bytes.length > MAX_INBOUND_FILE_BYTES || !sniffImageMime(bytes)) throw new Error('Unsupported thumbnail');
  // A missing or incompatible decoder must only fail this thumbnail, never API startup.
  const { default: sharp } = await import('sharp');
  // One frame only; limits apply before decoding untrusted image pixels.
  return sharp(bytes, { limitInputPixels: 25_000_000, failOn: 'warning', pages: 1 })
    .rotate()
    .resize(80, 80, { fit: 'cover', withoutEnlargement: true })
    .webp({ quality: 70 })
    .timeout({ seconds: 3 })
    .toBuffer();
}
