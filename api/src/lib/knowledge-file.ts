import { MAX_KNOWLEDGE_BYTES } from './knowledge-import.js';

export async function readKnowledgeFile(form: FormData) {
  const entries = [...form.values()].filter((value) => typeof value !== 'string');
  const file = form.get('file');
  if (entries.length !== 1 || form.getAll('file').length !== 1 || !file || typeof file === 'string')
    throw new Error('Choose one file to upload.');
  if (!file.size || file.size > MAX_KNOWLEDGE_BYTES)
    throw new Error('Choose a non-empty file up to 20 MB.');
  const filename = file.name.replace(/^.*[\\/]/, '').replace(/[\x00-\x1f]/g, '').slice(0, 200);
  if (!/\.(pdf|docx|pptx|png|jpg|jpeg|webp)$/i.test(filename))
    throw new Error('Use PNG, JPEG, WebP, PDF, DOCX or PPTX.');
  return { filename, bytes: new Uint8Array(await file.arrayBuffer()) };
}
