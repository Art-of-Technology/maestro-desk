import { test, expect } from 'bun:test';
import './bridge-smoke-shim-prefix.js';

const { captureTicketLayout, setComposerMode } = await import('../web/js/tickets/layout.js');
test('expand and restore preserve the editor, reading position and details preference', () => {
  const editor = { value: 'Unsent reply', focus() {} };
  const thread = { scrollTop: 123 };
  const root = { dataset: { composeMode: 'edit', details: 'show' },
    querySelector: selector => selector === '.thread' ? thread : selector === '.ql-editor, textarea.compose-area' ? editor : null,
    querySelectorAll: () => [],
  };
  document.getElementById = () => root;
  setComposerMode('test', 'expanded', true);
  expect(root.dataset.details).toBe('hide');
  expect(captureTicketLayout('test').detailsBeforeExpand).toBe('show');
  setComposerMode('test', 'expanded');
  setComposerMode('test', 'edit', true);
  expect(root.dataset.details).toBe('show');
  expect(editor.value).toBe('Unsent reply');
  expect(thread.scrollTop).toBe(123);
  root.dataset.details = 'hide';
  setComposerMode('test', 'expanded');
  setComposerMode('test', 'read', true);
  expect(root.dataset.details).toBe('hide');
});
