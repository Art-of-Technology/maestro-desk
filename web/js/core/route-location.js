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
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

// UUID-shaped slugs retain UUID links so legacy bookmarks stay unambiguous.
export function isReadableWorkspaceSlug(slug) {
  return typeof slug === 'string' && SLUG.test(slug) && !UUID.test(slug);
}

export function parseRoute(hash) {
  if (!hash?.startsWith('#/')) return null;
  try {
    const parts = hash.slice(2).split('/').map(decodeURIComponent);
    let workspaceId = null;
    let workspaceSlug = null;
    if (parts[0] === 'w') {
      parts.shift();
      const workspace = parts.shift();
      if (UUID.test(workspace || '')) workspaceId = workspace.toLowerCase();
      else if (isReadableWorkspaceSlug(workspace)) workspaceSlug = workspace;
      else return null;
    }
    const [page, entityId] = parts;
    if (!ROUTE_PAGES.has(page) || parts.length > 2 || (page === 'god' && (workspaceId || workspaceSlug))) return null;
    if (parts.length === 2 && (!['tickets', 'customers'].includes(page)
      || !(workspaceId ? UUID : DEMO_ID).test(entityId))) return null;
    return { workspaceId, page, entityId: entityId ? (workspaceId ? entityId.toLowerCase() : entityId) : null,
      ...(workspaceSlug ? { workspaceSlug } : {}) };
  } catch { return null; }
}

export function formatRoute({ workspaceId = null, workspaceSlug = null, page, entityId = null }) {
  if (workspaceSlug && !isReadableWorkspaceSlug(workspaceSlug)) throw new Error('Invalid workspace slug');
  const workspace = workspaceSlug || workspaceId;
  const hash = '#/' + (workspace ? `w/${workspace}/` : '') + page
    + (entityId ? `/${encodeURIComponent(entityId)}` : '');
  if (!parseRoute(hash)) throw new Error('Invalid route');
  return hash;
}
