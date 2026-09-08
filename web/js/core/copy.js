import { registerActions } from './event-delegation.js';
import { showToast } from './toast.js';

export function copyButton(value, label) {
  if (value == null || String(value).trim() === '') return '';
  const attr = window.escAttr;
  return `<button type="button" class="copy-value" data-action="copy.value" data-copy-value="${attr(String(value))}" title="Copy ${attr(label)}" aria-label="Copy ${attr(label)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/></svg></button>`;
}

registerActions({
  'copy.value': async (ds, el, event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(ds.copyValue);
      showToast('Copied', 'success', 1800);
    } catch {
      showToast('Could not copy. Select the text and copy it manually.', 'error');
    }
  },
});
