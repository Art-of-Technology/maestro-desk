import { SESSION } from '../core/state.js';
import { getJwt, getWorkspaceId } from '../core/api-client.js';
import { callClaude } from './client.js';

const pending = new Map();
const memory = new Map();
let database;

export function translationScope() {
  return SESSION?.userId && getWorkspaceId() && getJwt()
    ? JSON.stringify([SESSION.userId, getWorkspaceId()]) : null;
}

function openCache() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('respovia-translations', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('responses');
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = null; };
      resolve(request.result);
    };
    request.onblocked = () => reject(new Error('Close other Respovia tabs and try again to access saved translations.'));
    request.onerror = () => reject(new Error('Saved translations are unavailable in this browser.'));
  }).catch(error => { database = null; throw error; });
  return database;
}

async function read(key) {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const request = db.transaction('responses').objectStore('responses').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not read saved translations. Please try again.'));
  });
}

async function write(key, text) {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('responses', 'readwrite');
    tx.objectStore('responses').put(text, key);
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(new Error('Could not save translation.'));
  });
}

// Cache text responses, never generated HTML. Rich translations are rebuilt
// against the current sanitised tree, including current attachment URLs.
export function messageTranslationRequest(messageKey, scope = translationScope()) {
  const jwt = getJwt();
  const assertScope = () => {
    if (!scope || scope !== translationScope() || jwt !== getJwt()) throw new Error('Workspace changed. Please try again.');
  };
  return async (body) => {
    assertScope();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([1, scope, messageKey, body.system, body.messages])));
    const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const validate = text => {
      if (typeof text !== 'string' || !text.trim()) throw new Error('The translation was incomplete. Please try again.');
      if (body.system.startsWith('Translate each string in the JSON array')) {
        let data;
        try { data = JSON.parse(text); } catch { throw new Error('The translation was incomplete. Please try again.'); }
        const input = JSON.parse(body.messages[0].content);
        if (!Array.isArray(data) || data.length !== input.length || data.some(t => typeof t !== 'string' || !t.trim())) {
          throw new Error('The translation was incomplete. Please try again.');
        }
      }
    };
    const run = async () => {
      assertScope();
      if (memory.has(key)) return memory.get(key);
      const saved = await read(key);
      assertScope();
      if (saved !== undefined) {
        validate(saved);
        return { text: saved };
      }
      const result = await callClaude(body);
      assertScope();
      validate(result.text);
      const cached = { text: result.text };
      try { await write(key, result.text); } catch { cached.cacheWarning = true; }
      memory.set(key, cached);
      if (memory.size > 500) memory.delete(memory.keys().next().value);
      return cached;
    };
    if (!pending.has(key)) {
      const task = navigator.locks
        ? navigator.locks.request('respovia-translation:' + key, run) : run();
      pending.set(key, task);
      task.finally(() => { if (pending.get(key) === task) pending.delete(key); }).catch(() => {});
    }
    const result = await pending.get(key);
    assertScope();
    return result;
  };
}
