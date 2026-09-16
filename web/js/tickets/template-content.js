import { CUSTOMERS } from '../core/data.js';
import { SESSION, COMPOSE_TAB } from '../core/state.js';
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
  const composeTab = COMPOSE_TAB;
  if (!host) return false;
  await mountComposer(ticket.id);
  const active = () => host === document.getElementById('compose-' + ticket.id) && workspace === getWorkspaceId() && jwt === getJwt() && composeTab === COMPOSE_TAB;
  if (!active()) return false;
  const content = resolveTemplate(template, ticket);
  const missing = unresolvedVariables(content.text);
  const valuesFromForm = () => Object.fromEntries(missing.map((key, i) => [key.slice(1, -1), document.getElementById('tailor-' + i).value.trim()]));
  {
    showModal('Preview response', `<p>Check the customer details before inserting this response.${missing.length ? ' Fill in the missing fields below.' : ''}</p>${missing.map((key, i) => `<div class="form-row"><label class="form-label" for="tailor-${i}">${window.escHtml(key)}</label><input class="form-input" id="tailor-${i}" autocomplete="off" /></div>`).join('')}<div id="tailor-preview" style="white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--rule);padding:12px;border-radius:8px">${window.escHtml(content.text)}</div><p id="tailor-status" role="status"></p>`, () => {
      if (!active()) { closeModal(); return; }
      const values = valuesFromForm();
      if (Object.values(values).some(v => !v || unresolvedVariables(v).length)) {
        document.getElementById('tailor-status').textContent = 'Fill in every field with the details for this customer.';
        return;
      }
      const resolved = resolveTemplate(template, ticket, values);
      if (unresolvedVariables(resolved.html).length) {
        document.getElementById('tailor-status').textContent = 'This template has an unfilled field in its formatting or links. Edit the template before using it.';
        return;
      }
      appendHtml(ticket.id, resolved.html, resolved.text);
      document.getElementById('compose-' + ticket.id)?.dispatchEvent(new Event('input', { bubbles: true }));
      closeModal();
    }, 'Insert response', true);
    missing.forEach((key, i) => document.getElementById('tailor-' + i)?.addEventListener('input', () => {
      document.getElementById('tailor-preview').textContent = resolveTemplate(template, ticket, valuesFromForm()).text;
    }));
    const modal = document.getElementById('tailor-preview')?.closest?.('.modal');
    if (modal) {
      modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', 'Preview response'); modal.tabIndex = -1;
      const close = modal.querySelector('.modal-close');
      close.setAttribute('role', 'button'); close.setAttribute('aria-label', 'Close preview'); close.tabIndex = 0;
      modal.addEventListener('keydown', event => {
        if (event.key === 'Escape' || (event.target === close && ['Enter', ' '].includes(event.key))) {
          event.preventDefault(); closeModal(); if (active()) host.focus(); return;
        }
        if (event.key !== 'Tab') return;
        const nodes = [...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')];
        if (event.shiftKey && [nodes[0], modal].includes(document.activeElement)) { event.preventDefault(); nodes.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
      });
      modal.focus();
    }
    document.getElementById('tailor-0')?.focus();
    return false;
  }
}
