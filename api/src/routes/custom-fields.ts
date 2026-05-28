import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const customFields = new Hono();

customFields.use('*', requireAuth);

// Derive a stable snake_case key from a label. Used when the client
// doesn't supply one on POST. Append a 4-char random suffix on collision.
function keyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'field';
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

const FIELD_TYPES = ['text', 'number', 'date', 'select', 'multiselect', 'boolean'] as const;
const ENTITIES = ['customer', 'ticket'] as const;

const FieldBody = z.object({
  label:         z.string().min(1).max(200),
  field_type:    z.enum(FIELD_TYPES),
  entity_type:   z.enum(ENTITIES),
  key:           z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, 'key must be snake_case').optional(),
  options:       z.array(z.string()).nullable().optional(),
  required:      z.boolean().optional(),
  default_value: z.string().nullable().optional(),
  sort_order:    z.number().int().optional(),
});

customFields.get('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const { data, error } = await sb
    .from('custom_fields')
    .select('id, entity_type, key, label, field_type, options, required, default_value, sort_order, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .order('entity_type', { ascending: true })
    .order('sort_order',  { ascending: true })
    .order('label',       { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ custom_fields: data });
});

customFields.post('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = FieldBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  // Derive a key from the label if not provided. Retry up to a few times
  // on (workspace_id, entity_type, key) collision by appending a suffix.
  let key = input.key ?? keyFromLabel(input.label);
  const baseKey = key;

  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await sb
      .from('custom_fields')
      .insert({
        workspace_id:  workspaceId,
        entity_type:   input.entity_type,
        key,
        label:         input.label,
        field_type:    input.field_type,
        options:       input.options ?? null,
        required:      input.required ?? false,
        default_value: input.default_value ?? null,
        sort_order:    input.sort_order ?? 0,
      })
      .select('id, entity_type, key, label, field_type, options, required, default_value, sort_order, created_at, updated_at')
      .single();
    if (!error) return c.json({ custom_field: data }, 201);
    if (error.code !== '23505') return c.json({ error: error.message }, 500);
    // Collision — retry with a randomised key.
    key = `${baseKey}_${randomSuffix()}`;
  }
  return c.json({ error: 'Could not allocate a unique key after retries' }, 500);
});

// entity_type and key intentionally NOT in the patch schema — changing
// either would orphan custom_field_values rows referencing the old
// (entity_type, key) pair.
const PatchField = z.object({
  label:         z.string().min(1).max(200).optional(),
  field_type:    z.enum(FIELD_TYPES).optional(),
  options:       z.array(z.string()).nullable().optional(),
  required:      z.boolean().optional(),
  default_value: z.string().nullable().optional(),
  sort_order:    z.number().int().optional(),
}).strict();

customFields.patch('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchField.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  const { data, error } = await sb
    .from('custom_fields')
    .update(parsed.data)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id, entity_type, key, label, field_type, options, required, default_value, sort_order, updated_at')
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Custom field not found' }, 404);
  return c.json({ custom_field: data });
});

customFields.delete('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const { error } = await sb
    .from('custom_fields')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});
