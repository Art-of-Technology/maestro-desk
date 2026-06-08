import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. Member-level, workspace-scoped via getDb().
// Values are scoped through their parent custom_fields row's workspace_id.
export const customValues = new Hono();

customValues.use('*', requireAuth);

// ─── GET / — flat list of all custom-field values for the workspace ──────
// Joins custom_fields to expose the field key + entity_type so the client can
// group without a second lookup.
customValues.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const entityType = c.req.query('entity_type'); // optional filter

  const rows = await sql`
    select cfv.field_id, cf.key as field_key, cf.entity_type, cfv.entity_id, cfv.value, cfv.updated_at
    from custom_field_values cfv
    join custom_fields cf on cf.id = cfv.field_id
    where cf.workspace_id = ${workspaceId}
      ${entityType ? sql`and cf.entity_type = ${entityType}` : sql``}
  `;
  return c.json({ custom_values: rows });
});

// ─── PUT /customers/:customerId/:fieldKey — upsert a customer value ──────
// Body: { value }. An empty / null value deletes the row so "clear field" is
// a real null rather than an empty string in stored data.
const PutValue = z.object({
  value: z.string().nullable(),
});

customValues.put('/customers/:customerId/:fieldKey', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('customerId');
  const fieldKey = c.req.param('fieldKey');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PutValue.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const value = parsed.data.value;

  // Resolve the field UUID from (workspace, entity_type='customer', key).
  const [field] = await sql`
    select id from custom_fields
    where workspace_id = ${workspaceId} and entity_type = 'customer' and key = ${fieldKey}
  `;
  if (!field) return c.json({ error: 'Custom field not found' }, 404);

  // Confirm the customer belongs to this workspace.
  const [customer] = await sql`
    select id from customers
    where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!customer) return c.json({ error: 'Customer not found' }, 404);

  // Empty / null value → delete the row so reads see the field as unset.
  if (value === null || value === '') {
    await sql`delete from custom_field_values where field_id = ${field.id} and entity_id = ${customerId}`;
    return c.json({ field_id: field.id, field_key: fieldKey, value: null });
  }

  const [row] = await sql`
    insert into custom_field_values (workspace_id, field_id, entity_type, entity_id, value)
    values (${workspaceId}, ${field.id}, 'customer', ${customerId}, ${value})
    on conflict (field_id, entity_id) do update
      set value = excluded.value, updated_at = now()
    returning field_id, entity_id, value, updated_at
  `;
  return c.json({
    field_id:   row.field_id,
    field_key:  fieldKey,
    entity_id:  row.entity_id,
    value:      row.value,
    updated_at: row.updated_at,
  });
});
