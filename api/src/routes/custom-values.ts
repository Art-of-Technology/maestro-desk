import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const customValues = new Hono();

customValues.use('*', requireAuth);

// ─── GET / — flat list of all custom-field values for the workspace ──────
//
// Bootstrap loads everything once. The values table is small in v1
// (entities × fields), so embedding per-customer or per-ticket would be
// more round-trips for less. Join custom_fields to get the field key +
// entity_type so the client can group without a second lookup.
customValues.get('/', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const entityType = c.req.query('entity_type'); // optional filter

  let query = sb
    .from('custom_field_values')
    .select(`
      field_id, entity_id, value, updated_at,
      custom_fields!inner(workspace_id, entity_type, key)
    `)
    .eq('custom_fields.workspace_id', workspaceId);
  if (entityType) {
    query = query.eq('custom_fields.entity_type', entityType);
  }
  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);

  const values = (data || []).map((r: any) => ({
    field_id:    r.field_id,
    field_key:   r.custom_fields.key,
    entity_type: r.custom_fields.entity_type,
    entity_id:   r.entity_id,
    value:       r.value,
    updated_at:  r.updated_at,
  }));
  return c.json({ custom_values: values });
});

// ─── PUT /customers/:customerId/:fieldKey — upsert a customer value ──────
//
// Resolves to /api/v1/custom-values/customers/:customerId/:fieldKey.
// Body: { value }. An empty / null value deletes the row so "clear
// field" is a real null rather than an empty string in stored data.
const PutValue = z.object({
  value: z.string().nullable(),
});

customValues.put('/customers/:customerId/:fieldKey', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('customerId');
  const fieldKey = c.req.param('fieldKey');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PutValue.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const value = parsed.data.value;

  // Look up the field UUID from (workspace, entity_type='customer', key).
  const { data: field, error: fErr } = await sb
    .from('custom_fields')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('entity_type', 'customer')
    .eq('key', fieldKey)
    .maybeSingle();
  if (fErr) return c.json({ error: fErr.message }, 500);
  if (!field) return c.json({ error: 'Custom field not found' }, 404);

  // Confirm the customer belongs to this workspace.
  const { data: customer, error: cErr } = await sb
    .from('customers')
    .select('id')
    .eq('id', customerId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (cErr) return c.json({ error: cErr.message }, 500);
  if (!customer) return c.json({ error: 'Customer not found' }, 404);

  // Empty / null value → delete the row so reads see the field as unset.
  if (value === null || value === '') {
    const { error: delErr } = await sb
      .from('custom_field_values')
      .delete()
      .eq('field_id', field.id)
      .eq('entity_id', customerId);
    if (delErr) return c.json({ error: delErr.message }, 500);
    return c.json({ field_id: field.id, field_key: fieldKey, value: null });
  }

  const { data, error: upErr } = await sb
    .from('custom_field_values')
    .upsert(
      {
        workspace_id: workspaceId,
        field_id:     field.id,
        entity_type:  'customer',
        entity_id:    customerId,
        value,
      },
      { onConflict: 'field_id,entity_id' },
    )
    .select('field_id, entity_id, value, updated_at')
    .single();
  if (upErr) return c.json({ error: upErr.message }, 500);

  return c.json({
    field_id:   data.field_id,
    field_key:  fieldKey,
    entity_id:  data.entity_id,
    value:      data.value,
    updated_at: data.updated_at,
  });
});
