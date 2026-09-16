import { CUSTOMERS } from '../core/data.js';
import { SESSION } from '../core/state.js';
import { getWorkspaceId, getJwt } from '../core/api-client.js';
import { mountComposer, appendHtml } from './composer.js';
import { showModal, closeModal } from '../core/modal.js';

export function unresolvedVariables(text) {
  return [...new Set(String(text || '').match(/\{[a-z][a-z0-9_]*\}/gi) || [])];
}

export function resolveTemplate(template, ticket, tailored = {}) {
  const customer = CUSTOMERS.find(c => c.id === ticket.customerId);
  const values = { name: customer?.first, ticket: ticket.id,
    brand: customer?.brand, agent: ticket.agent || SESSION?.name, ...tailored };
  const replace = text => text.replace(/\{([a-z][a-z0-9_]*)\}/gi, (original, key) => Object.hasOwn(values, key) && values[key] ? values[key] : original);
  let html = template.html || null;
  if (html) {
    // Only text nodes: customer values cannot introduce markup or alter URLs.
    const fragment = document.createElement('template');
    fragment.innerHTML = html;
    const walker = document.createTreeWalker(fragment.content, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) walker.currentNode.nodeValue = replace(walker.currentNode.nodeValue);
    html = fragment.innerHTML;
  }
  return { text: replace(template.text || ''), html };
}

export async function appendTemplate(ticket, template) {
  const host = document.getElementById('compose-' + ticket.id);
  const workspace = getWorkspaceId();
  const jwt = getJwt();
  if (!host) return false;
  await mountComposer(ticket.id);
  const active = () => host === document.getElementById('compose-' + ticket.id) && workspace === getWorkspaceId() && jwt === getJwt();
  if (!active()) return false;
  const content = resolveTemplate(template, ticket);
  const missing = unresolvedVariables(content.text);
  if (missing.length) {
    showModal('Tailor this response', `<p>Fill in these details before inserting the template.</p>${missing.map((key, i) => `<div class="form-row"><label class="form-label" for="tailor-${i}">${window.escHtml(key)}</label><input class="form-input" id="tailor-${i}" autocomplete="off" /></div>`).join('')}<p id="tailor-status" role="status"></p>`, () => {
      if (!active()) { closeModal(); return; }
      const values = Object.fromEntries(missing.map((key, i) => [key.slice(1, -1), document.getElementById('tailor-' + i).value.trim()]));
      if (Object.values(values).some(v => !v || unresolvedVariables(v).length)) {
        document.getElementById('tailor-status').textContent = 'Fill in every field with the details for this customer.';
        return;
      }
      const resolved = resolveTemplate(template, ticket, values);
      appendHtml(ticket.id, resolved.html, resolved.text);
      document.getElementById('compose-' + ticket.id)?.dispatchEvent(new Event('input', { bubbles: true }));
      closeModal();
    }, 'Insert response', true);
    document.getElementById('tailor-0')?.focus();
    return false;
  }
  appendHtml(ticket.id, content.html, content.text);
  return true;
}
