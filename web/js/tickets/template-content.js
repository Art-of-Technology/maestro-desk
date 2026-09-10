import { CUSTOMERS } from '../core/data.js';
import { SESSION } from '../core/state.js';
import { getWorkspaceId } from '../core/api-client.js';
import { mountComposer, appendHtml } from './composer.js';

export function resolveTemplate(template, ticket) {
  const customer = CUSTOMERS.find(c => c.id === ticket.customerId);
  const values = { name: customer?.first || 'there', ticket: ticket.id,
    brand: customer?.brand || '', agent: ticket.agent || SESSION?.name || '' };
  const replace = text => text.replace(/\{(name|ticket|brand|agent)\}/g, (_, key) => values[key]);
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
  if (!host) return false;
  await mountComposer(ticket.id);
  if (host !== document.getElementById('compose-' + ticket.id) || workspace !== getWorkspaceId()) return false;
  const content = resolveTemplate(template, ticket);
  appendHtml(ticket.id, content.html, content.text);
  return true;
}
