import { test, expect } from 'bun:test';
import { attachKnowledgeFilePicker, knowledgeFileError } from '../web/js/kb/file-picker.js';

class Element extends EventTarget {
  isConnected = true;
  value = '';
  attributes = {};
  classes = new Set();
  classList = { add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name) };
  setAttribute(key, value) { this.attributes[key] = value; }
  focus() { this.focused = true; }
}
function fixture() {
  const nodes = Object.fromEntries(['ks-file', 'ks-drop-zone', 'ks-file-selection', 'ks-file-error', 'ks-drop-label', 'choose'].map((id) => [id, new Element()]));
  const root = new Element();
  root.parentNode = new Element();
  root.querySelector = (selector) => nodes[selector.startsWith('#') ? selector.slice(1) : 'choose'];
  const doc = new Element();
  doc.getElementById = () => new Element();
  globalThis.document = doc;
  let removed;
  globalThis.MutationObserver = class {
    constructor(callback) { removed = callback; }
    observe() {} disconnect() {}
  };
  const picker = attachKnowledgeFilePicker(root);
  const drop = (files, target = nodes['ks-drop-zone'], type = 'drop') => {
    const event = new Event(type, { cancelable: true });
    event.dataTransfer = { files, types: ['Files'] };
    target.dispatchEvent(event);
    return event;
  };
  return { picker, nodes, root, doc, drop, removed: () => removed() };
}
test('validates single supported, non-empty files up to 20 MB', () => {
  expect(knowledgeFileError([])).toContain('one file');
  expect(knowledgeFileError([new File(['x'], 'bad.exe')])).toContain('Use PDF');
  expect(knowledgeFileError([new File([], 'empty.pdf')])).toContain('non-empty');
  expect(knowledgeFileError([{ name: 'large.pdf', size: 20 * 1024 * 1024 + 1 }])).toContain('20 MB');
  expect(knowledgeFileError([{ name: 'policy.PDF', size: 20 * 1024 * 1024 }])).toBe('');
});
test('drop and chooser share selection; invalid drops clear stale files; processing locks selection', () => {
  const { picker, nodes, drop } = fixture();
  const file = new File(['policy'], 'policy.pdf');
  expect(drop([file]).defaultPrevented).toBe(true);
  expect(picker.getFile()).toBe(file);
  expect(nodes['ks-file-selection'].textContent).toContain('policy.pdf');
  drop([file, file]);
  expect(picker.getFile()).toBeNull();
  expect(nodes['ks-file-error'].textContent).toContain('one file');
  expect(nodes.choose.focused).toBe(true);
  nodes['ks-file'].files = [file];
  nodes['ks-file'].dispatchEvent(new Event('change'));
  expect(picker.getFile()).toBe(file);
  picker.setBusy(true);
  drop([new File(['other'], 'other.pdf')]);
  expect(picker.getFile()).toBe(file);
  expect(nodes.choose.disabled).toBe(true);
  picker.setBusy(false);
  expect(nodes.choose.disabled).toBe(false);
});
test('file drops outside the target cannot navigate away, and listeners are removed on close', () => {
  const { root, doc, nodes, drop, removed } = fixture();
  drop([], nodes['ks-drop-zone'], 'dragenter');
  expect(nodes['ks-drop-zone'].classes.has('is-dragging')).toBe(true);
  drop([], nodes['ks-drop-zone'], 'dragleave');
  expect(nodes['ks-drop-zone'].classes.has('is-dragging')).toBe(false);
  expect(drop([], doc).defaultPrevented).toBe(true);
  root.isConnected = false;
  removed();
  expect(drop([], doc).defaultPrevented).toBe(false);
});
