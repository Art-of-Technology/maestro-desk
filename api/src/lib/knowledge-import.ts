import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Agent, fetch as safeFetch } from 'undici';
import { assertSafeWebhookUrl, safeLookup } from './ssrf.js';

export const MAX_KNOWLEDGE_BYTES = 20 * 1024 * 1024;
export type Extracted = { body: string; warnings: string[] };
// Exact application-authored messages only; never expose arbitrary parser,
// storage or network errors (which can contain paths, credentials or URLs).
const publicErrors = new Set([
  'Document extraction is busy. Try Refresh now shortly.',
  'Extraction timed out. Split the file into smaller parts.',
  'Document extraction is unavailable on this server.',
  'Extracted content is too large.',
  'Extracted content is too large. Split the document into smaller files.',
  'The expanded document exceeds the import limit.',
  'Split presentations longer than 30 slides.',
  'Split PDFs longer than 30 pages.',
  'Extracted text exceeds 200,000 characters. Split the source.',
  'No readable text found. Try a clearer scan or paste the text.',
  'The image content does not match its file type.',
  'This is not a valid PDF.',
  'Web page exceeds the 2 MB import limit.',
  'Website lookup timed out.',
]);
export function publicKnowledgeError(error: unknown): string {
  return error instanceof Error && publicErrors.has(error.message)
    ? error.message
    : 'Could not read the source. Check the URL or file and try again.';
}
const agent = new Agent({
  connect: { lookup: safeLookup },
  headersTimeout: 15000,
  bodyTimeout: 15000,
});
let documentExtractions = 0;
export function canonicalKnowledgeUrl(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443'))
    throw new Error('Use a public HTTPS page without credentials or a custom port.');
  u.hash = '';
  return u.href;
}
export async function fetchKnowledgePage(raw: string): Promise<Uint8Array> {
  let url = canonicalKnowledgeUrl(raw);
  const signal = AbortSignal.timeout(20000);
  for (let i = 0; i < 5; i++) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error('Website lookup timed out.'));
      signal.addEventListener('abort', abort, { once: true });
      assertSafeWebhookUrl(url)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
    const res = await safeFetch(url, {
      dispatcher: agent,
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': 'Respovia-Knowledge/1.0', Accept: 'text/html' },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new Error('Website returned an invalid redirect.');
      url = canonicalKnowledgeUrl(new URL(location, url).href);
      continue;
    }
    if (
      !res.ok ||
      !/text\/html|application\/xhtml\+xml/i.test(res.headers.get('content-type') || '')
    ) {
      await res.body?.cancel();
      throw new Error(
        `Website could not be imported (HTTP ${res.status}). Use a public HTML page.`,
      );
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Website returned no content.');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) throw new Error('Web page exceeds the 2 MB import limit.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Too many website redirects.');
}

export async function extractKnowledge(bytes: Uint8Array, extension: string): Promise<Extracted> {
  if (!bytes.length || bytes.length > MAX_KNOWLEDGE_BYTES)
    throw new Error('Choose a non-empty file up to 20 MB.');
  if (!['html', 'pdf', 'docx', 'pptx', 'png', 'jpg', 'jpeg', 'webp'].includes(extension))
    throw new Error('Use PNG, JPEG, WebP, PDF, DOCX or PPTX.');
  // OCR/native parsers are expensive. Reject excess work rather than allowing
  // several workspaces to exhaust the API host; the saved source can be retried.
  const document = extension !== 'html';
  if (document && documentExtractions >= 2)
    throw new Error('Document extraction is busy. Try Refresh now shortly.');
  if (document) documentExtractions++;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'respovia-kb-'));
    const file = path.join(dir, `source.${extension}`);
    await writeFile(file, bytes);
    return await new Promise<Extracted>((resolve, reject) => {
      const child = spawn(
        'python3',
        [
          fileURLToPath(new URL('../../scripts/knowledge_extract.py', import.meta.url)),
          file,
          extension,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
          env: { PATH: process.env.PATH, LANG: 'C.UTF-8', OMP_THREAD_LIMIT: '1' },
        },
      );
      let output = '';
      let settled = false;
      const kill = () => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {}
      };
      const timer = setTimeout(() => {
        kill();
        finish(new Error('Extraction timed out. Split the file into smaller parts.'));
      }, 90000);
      const finish = (err?: Error, data?: Extracted) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(data!);
      };
      child.stdout.on('data', (data) => {
        output += data.toString();
        if (output.length > 1_000_000) {
          kill();
          finish(new Error('Extracted content is too large.'));
        }
      });
      child.stderr.resume();
      child.on('error', () =>
        finish(new Error('Document extraction is unavailable on this server.')),
      );
      child.on('close', (code) => {
        if (settled) return;
        try {
          const data = JSON.parse(output);
          if (code || typeof data.body !== 'string' || !Array.isArray(data.warnings))
            throw new Error(
              data.error || 'Unable to read this file. Check its format and password protection.',
            );
          finish(undefined, data);
        } catch (e) {
          finish(e instanceof Error ? e : new Error('Extraction failed.'));
        }
      });
    });
  } finally {
    if (document) documentExtractions--;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
