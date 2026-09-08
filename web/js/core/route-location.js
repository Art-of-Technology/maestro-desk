// Fragment routes work on the static host without changing asset/portal paths.
// Only route IDs belong here: never account details, search text or credentials.
export const ROUTE_PAGES = new Set([
  'dashboard', 'tickets', 'customers', 'reports', 'agents', 'ai', 'kb', 'tags',
  'roles', 'sla', 'business-hours', 'assignment-rules', 'csat', 'templates',
  'macros', 'ticket-templates', 'custom-fields', 'layouts', 'activity',
  'sla-breach', 'portal', 'search', 'channels', 'webhooks', 'settings', 'config',
  'help', 'notifications', 'profile', 'god',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEMO_ID = /^[a-z0-9_-]{1,80}$/i;

export function parseRoute(hash) {
  if (!hash?.startsWith('#/')) return null;
  try {
    const parts = hash.slice(2).split('/').map(decodeURIComponent);
    let workspaceId = null;
    if (parts[0] === 'w') {
      parts.shift();
      workspaceId = parts.shift();
      if (!UUID.test(workspaceId || '')) return null;
      workspaceId = workspaceId.toLowerCase();
    }
    const [page, entityId] = parts;
    if (!ROUTE_PAGES.has(page) || parts.length > 2 || (page === 'god' && workspaceId)) return null;
    if (parts.length === 2 && (!['tickets', 'customers'].includes(page)
      || !(workspaceId ? UUID : DEMO_ID).test(entityId))) return null;
    return { workspaceId, page, entityId: entityId ? (workspaceId ? entityId.toLowerCase() : entityId) : null };
  } catch { return null; }
}

export function formatRoute({ workspaceId = null, page, entityId = null }) {
  const hash = '#/' + (workspaceId ? `w/${workspaceId}/` : '') + page
    + (entityId ? `/${encodeURIComponent(entityId)}` : '');
  if (!parseRoute(hash)) throw new Error('Invalid route');
  return hash;
}
