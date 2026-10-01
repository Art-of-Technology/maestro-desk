// Run under Node (the production runtime), including a forced WebAssembly fallback.
import assert from 'node:assert/strict';
import Module from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (!mode) {
  for (const variant of ['wasm', 'missing']) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), variant], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(child.status, 0, `${variant}: ${child.error || child.stderr || child.stdout}`);
    console.log(child.stdout.trim());
  }
} else {
  const load = Module._load;
  Module._load = function (id, ...args) {
    if (id.startsWith('@img/sharp-') && (mode === 'missing' || !id.startsWith('@img/sharp-wasm32'))) {
      throw new Error('Decoder unavailable for runtime check');
    }
    return load.call(this, id, ...args);
  };
  const { attachmentThumbnail } = await import('../src/lib/attachment-thumbnail.ts');
  if (mode === 'missing') {
    await assert.rejects(attachmentThumbnail(Buffer.from([0xff, 0xd8, 0xff])));
    console.log('Missing decoder: module loads, thumbnail fails safely.');
  } else {
    const { default: sharp } = await import('sharp');
    assert.ok(sharp.versions.emscripten, 'Must exercise WebAssembly, not the native decoder');
    const input = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: 'purple' } }).png().toBuffer();
    const start = performance.now();
    const thumbnail = await attachmentThumbnail(input);
    const metadata = await sharp(thumbnail).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 80);
    assert.equal(metadata.height, 80);
    assert.ok(thumbnail.length < input.length / 10);
    console.log(`WebAssembly: ${input.length} -> ${thumbnail.length} bytes, ${Math.round(performance.now() - start)}ms.`);
  }
}
