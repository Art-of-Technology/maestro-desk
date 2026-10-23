import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getDb } from './db.js';

// The API ships this catalogue to the editor: labels and enforceable keys stay together.
export const permissionGroups = [
  { name: 'Tickets', permissions: [
    ['tickets.view_assigned', 'View assigned tickets'], ['tickets.view_all', 'View all brand tickets'],
    ['tickets.create', 'Create tickets'], ['tickets.reply', 'Send customer replies'],
    ['tickets.note', 'Add internal notes'], ['tickets.attach', 'Upload attachments'],
    ['tickets.assign_self', 'Assign tickets to self'], ['tickets.assign', 'Assign / reassign other agents'],
    ['tickets.edit', 'Change status, priority and category'], ['tickets.close', 'Close / reopen tickets'],
    ['tickets.delete', 'Delete tickets'],
  ] },
  { name: 'Contacts', permissions: [
    ['customers.view', 'View contact profiles'], ['customers.edit', 'Edit profiles and notes'],
    ['customers.contact_add', 'Add email or mobile'], ['customers.contact_primary', 'Change primary email or mobile'],
    ['customers.contact_remove', 'Remove secondary email or mobile'], ['customers.merge', 'Merge / unmerge profiles'],
    ['customers.delete', 'Delete contact profiles and notes'], ['customers.spam', 'Mark / unmark spam'],
  ] },
  { name: 'Data & tools', permissions: [
    ['data.reports', 'View brand reports'], ['data.ai_reports', 'View AI feedback reports'],
    ['data.export_lists', 'Export visible lists and reports'], ['data.export_emails', 'Download ticket emails'], ['data.export', 'Export complete customer records'],
    ['data.audit', 'View activity history'], ['data.edit_history', 'View note edit history'], ['data.erase_request', 'Set GDPR ticket status'],
    ['data.erase', 'Perform customer erasure'], ['tools.ai', 'Use AI assistance'],
    ['tools.templates', 'Manage response templates and macros'], ['tools.ticket_templates', 'Manage ticket templates'], ['tools.kb', 'Manage knowledge articles and sources'],
    ['tools.custom_fields', 'Manage custom-field definitions'],
  ] },
  { name: 'Administration', permissions: [
    ['admin.agents', 'Invite / deactivate agents'], ['admin.assign_roles', 'Assign non-admin roles'],
    ['admin.inboxes', 'Manage inboxes and routing'], ['admin.integrations', 'Manage integrations'],
    ['admin.settings', 'Manage brand settings'],
  ] },
] as const;
export const permissionKeys = permissionGroups.flatMap(group => group.permissions.map(([key]) => key));
export type Permission = (typeof permissionKeys)[number];
export type Permissions = Record<Permission, boolean>;
export interface PermissionRole {
  is_admin?: boolean | null;
  can_manage_custom_fields?: boolean | null;
  can_delete?: boolean | null;
  permissions?: Partial<Permissions> | null;
}
const legacyMembers = new Set<Permission>([
  'tickets.view_assigned', 'tickets.view_all', 'tickets.create', 'tickets.reply', 'tickets.note', 'tickets.attach',
  'tickets.assign_self', 'tickets.assign', 'tickets.edit', 'tickets.close',
  'customers.view', 'customers.edit', 'customers.contact_add', 'customers.contact_primary', 'customers.contact_remove', 'customers.spam',
  'data.reports', 'data.export_lists', 'data.export_emails', 'data.audit', 'data.erase_request', 'tools.ai', 'tools.ticket_templates',
]);
export function effectivePermissions(role: PermissionRole, platformAdmin = false): Permissions {
  return Object.fromEntries(permissionKeys.map(key => [key, Boolean(platformAdmin || role.is_admin || (
    role.permissions != null ? role.permissions[key] === true
      : legacyMembers.has(key) || (key === 'tools.custom_fields' && role.can_manage_custom_fields)
        || (['tickets.delete', 'customers.delete', 'customers.merge'].includes(key) && role.can_delete)
  ))])) as Permissions;
}

export function allowed(c: Context, key: Permission): boolean {
  return c.get('rolePermissions')?.[key] === true;
}
export async function requirePermission(c: Context, key: Permission): Promise<Response | null> {
  return allowed(c, key) ? null : c.json({ error: 'Your role does not allow this action.', permission: key }, 403);
}
export function ticketAssigneeScope(c: Context): string | null {
  return allowed(c, 'tickets.view_all') ? null : allowed(c, 'tickets.view_assigned') ? c.get('userId') : '';
}
export async function checkTicketAccess(c: Context, id: string) {
  const scope = ticketAssigneeScope(c);
  if (scope === null) return;
  const sql = getDb();
  const [ticket] = scope ? await sql`select id from tickets where workspace_id=${c.get('workspaceId')}
    and id=${id} and assigned_user_id=${scope} and deleted_at is null` : [];
  if (!ticket) throw new HTTPException(404, { message: 'Ticket not found.' });
}

export async function userCanViewTicket(workspaceId: string, userId: string, ticketId: string): Promise<boolean> {
  const sql = getDb();
  const [row] = await sql`select r.is_admin, r.can_delete, r.can_manage_custom_fields, r.permissions,
    u.is_platform_admin, t.assigned_user_id from users u
    join tickets t on t.workspace_id=${workspaceId} and t.id=${ticketId} and t.deleted_at is null
    left join workspace_members wm on wm.user_id=u.id and wm.workspace_id=t.workspace_id and wm.active
    left join roles r on r.id=wm.role_id and r.workspace_id=wm.workspace_id
    where u.id=${userId} and u.deleted_at is null and (wm.user_id is not null or u.is_platform_admin)`;
  if (!row) return false;
  const grants = effectivePermissions(row, row.is_platform_admin);
  return grants['tickets.view_all'] || grants['tickets.view_assigned'] && row.assigned_user_id === userId;
}

// Runs after verified identity and active brand membership on every authenticated request.
export async function authorizeRoleRequest(c: Context) {
  let decoded: string;
  try { decoded = decodeURIComponent(c.req.path); }
  catch { throw new HTTPException(400, { message: 'Invalid request path.' }); }
  const path = decoded.replace(/^\/api\/v1\//, '').split('/');
  const [area, id, action, child, last] = path;
  const method = c.req.method, write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  // JSON handlers parse regardless of Content-Type; leave binary upload bodies untouched.
  const parsedBody = write && ['tickets', 'customers', 'ai', 'custom-values'].includes(area) && !(area === 'tickets' && action === 'attachments')
    ? await c.req.json().catch(() => ({})) : {};
  const body = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody) ? parsedBody : {};
  const need = (key: Permission) => {
    if (!allowed(c, key)) throw new HTTPException(403, { message: 'Your role does not allow this action.' });
  };
  const anyTicket = () => { if (!allowed(c, 'tickets.view_all') && !allowed(c, 'tickets.view_assigned')) need('tickets.view_all'); };
  if (area === 'tickets') {
    anyTicket();
    if (id && /^[0-9a-f-]{36}$/i.test(id)) await checkTicketAccess(c, id);
    if (!write) {
      if (action === 'emails' && (child === 'download' || last === 'download') || action === 'download') need('data.export_emails');
      if (last === 'history' || child === 'history') need('data.edit_history');
      return;
    }
    if (!id) {
      need('tickets.create');
      if (body.assigned_user_id && body.assigned_user_id !== c.get('userId')) need('tickets.assign');
      if (body.status_key || body.status_option_key) {
        const [status] = await getDb()`select base_key from ticket_statuses where workspace_id=${c.get('workspaceId')}
          and key=${body.status_option_key || body.status_key}`;
        if (status?.base_key === 'gdpr') need('data.erase_request');
        if (['resolved','closed'].includes(status?.base_key)) need('tickets.close');
      }
      return;
    }
    if (!action && method === 'DELETE') { if (!c.get('legacyPermissions')) need('tickets.delete'); }
    else if (!action && method === 'PATCH') {
      if (body.assigned_user_id !== undefined) need(body.assigned_user_id === c.get('userId') ? 'tickets.assign_self' : 'tickets.assign');
      if (Object.keys(body).some(key => key !== 'assigned_user_id')) need('tickets.edit');
      if (body.status_key !== undefined || body.status_option_key !== undefined) {
        const sql = getDb();
        // The database normalises status_key to a base category, including custom options.
        const [status] = await sql`select t.status_key as before, s.base_key as after from tickets t
          left join ticket_statuses s on s.workspace_id=t.workspace_id and s.key=${body.status_option_key || body.status_key}
          where t.workspace_id=${c.get('workspaceId')} and t.id=${id}`;
        if (['resolved','closed'].includes(status?.before) || ['resolved','closed'].includes(status?.after)) need('tickets.close');
        if (status?.after === 'gdpr') need('data.erase_request');
      }
    } else if (action === 'messages') need(body.role === 'note' ? 'tickets.note' : 'tickets.reply');
    else if (action === 'drafts') need(child === 'note' ? 'tickets.note' : 'tickets.reply');
    else if (action === 'attachments') need('tickets.attach');
    else if (action === 'close' || action === 'snooze' || action === 'close-reminder') need('tickets.close');
    else if (action === 'merge' || action === 'unmerge') { need('tickets.edit'); if (body.into_id) await checkTicketAccess(c, body.into_id); }
    else if (action === 'apply-rules') need('tickets.assign');
    else if (action === 'emails' || action === 'csat') need('tickets.reply');
    else if (action === 'triage' || action === 'ai-draft' || action === 'sentiment') need('tools.ai');
    else need('tickets.edit');
  } else if (area === 'customers') {
    need('customers.view');
    if (['summary', 'tickets', 'risk'].includes(action)) {
      // These views include brand-wide history and risk signals.
      need('tickets.view_all');
    }
    if (!write) { if (action === 'export') { need('data.export'); need('tickets.view_all'); } if (last === 'history') need('data.edit_history'); return; }
    if (action === 'contacts') need(method === 'DELETE' ? 'customers.contact_remove' : child && last === 'primary' ? 'customers.contact_primary' : 'customers.contact_add');
    else if (action === 'merge' || action === 'unmerge') { need('customers.merge'); need('tickets.view_all'); }
    else if (action === 'erase') { need('data.erase'); need('tickets.view_all'); }
    else if (action === 'spam') need('customers.spam');
    else if (method === 'DELETE' && !action) need('customers.delete');
    else need('customers.edit');
    if (action === 'contacts' && !child && body.primary === true) need('customers.contact_primary');
  } else if (['canned-responses', 'ticket-templates', 'macros'].includes(area) && write && action !== 'use') need(area === 'ticket-templates' ? 'tools.ticket_templates' : 'tools.templates');
  else if (area === 'reports') {
    need('data.reports'); need('tickets.view_all');
    if (id === 'reply-performance') need('data.ai_reports');
    if (c.req.query('export')) need('data.export_lists');
  }
  else if (area === 'activity') { need('data.audit'); need('tickets.view_all'); need('customers.view'); }
  else if (area === 'ai') {
    if (id === 'reply-feedback') {
      if (!write) { need('data.ai_reports'); need('tickets.view_all'); }
      else if (action && /^[0-9a-f-]{36}$/i.test(action)) {
        const [suggestion] = await getDb()`select ticket_id from ai_reply_suggestions
          where workspace_id=${c.get('workspaceId')} and id=${action}`;
        if (!suggestion) throw new HTTPException(404, { message: 'Suggestion not found.' });
        await checkTicketAccess(c, suggestion.ticket_id);
      }
    }
    if (write) { need('tools.ai'); if (body.ticketId) await checkTicketAccess(c, body.ticketId); if (body.action === 'similar_reply') need('tickets.view_all'); }
  } else if (area === 'pubby' && id === 'auth') need('tickets.view_all');
  else if (area === 'inbox') { need('tickets.view_all'); if (write) need('tickets.create'); }
  else if (area === 'presence') {
    if (id === 'ticket' && action) { anyTicket(); await checkTicketAccess(c, action); }
    if (id === 'customer') need('customers.view');
  } else if (area === 'custom-values') {
    const entity = body.entity_type || c.req.query('entity_type') || id;
    if (entity === 'ticket') { anyTicket(); if (body.entity_id || action) await checkTicketAccess(c, body.entity_id || action); }
    else if (entity === 'customer' || entity === 'customers') need(write ? 'customers.edit' : 'customers.view');
    else { need('customers.view'); need('tickets.view_all'); }
  }
}
