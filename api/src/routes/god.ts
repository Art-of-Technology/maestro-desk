import { Hono } from 'hono';
import { z } from 'zod';
import { requirePlatformAdmin, writeAudit } from '../middleware/platform-admin.ts';

export const god = new Hono();

god.use('*', requirePlatformAdmin);

// ─── Schemas ───────────────────────────────────────────────────────────────

// Slug is what shows up in URLs + the `__unrouted` system row uses a `__`
// prefix, so brand slugs must NOT start with that. Length cap keeps URL
// paths and Postmark Sender Signature names sane.
const Slug = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits, hyphens — must start and end alphanumeric')
  .refine((s) => !s.startsWith('__'), 'slug cannot start with "__" (reserved for system rows)');

// Domain validation is light — we accept any string with at least one dot.
// Postmark + DNS verification will catch invalid domains later. Lowercased
// here so the lookup against citext is fully deterministic.
const Domain = z
  .string()
  .min(3)
  .max(253)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => s.includes('.'), 'domain must contain a dot');

const CreateBrand = z.object({
  name: z.string().min(1).max(120),
  slug: Slug,
  domain: Domain.optional(),
  logo_url: z.string().url().optional(),
  primary_color: z.string().max(32).optional(),  // e.g. '#0a84ff' or 'var(--brand)'; free-form
  support_email_display_name: z.string().max(120).optional(),
  ai_credits_micro: z.number().int().min(0).max(10_000_000_000).default(0),
  auto_reply_min_confidence: z.number().int().min(0).max(100).nullable().default(null),
  auto_reply_categories: z.array(z.string()).default([]),
});

const UpdateBrand = z.object({
  name: z.string().min(1).max(120).optional(),
  logo_url: z.string().url().nullable().optional(),
  primary_color: z.string().max(32).nullable().optional(),
  support_email_display_name: z.string().max(120).nullable().optional(),
  ai_credits_micro: z.number().int().min(0).max(10_000_000_000).optional(),
  auto_reply_min_confidence: z.number().int().min(0).max(100).nullable().optional(),
  auto_reply_categories: z.array(z.string()).optional(),
  // null = unsuspend; ISO string or 'now' to suspend. Use null/now sugar so
  // the UI doesn't have to construct timestamps.
  suspended_at: z.union([z.literal('now'), z.string().datetime(), z.null()]).optional(),
});

// Maps a Postgres error to an HTTP status. The interesting cases for brand
// provisioning are duplicate slug (workspaces_slug_key) and duplicate
// domain (workspace_email_domains_domain_active_uq) — both 23505.
function pgErrorToStatus(code: string | undefined): number {
  if (code === '23505') return 409;  // unique violation
  if (code === '23503') return 400;  // foreign key violation
  return 500;
}

// ─── Routes ────────────────────────────────────────────────────────────────

// POST /api/v1/god/brands — provision a new white-label brand.
god.post('/brands', async (c) => {
  const sb = c.get('sb');
  const actorUserId = c.get('userId');

  const body = await c.req.json().catch(() => null);
  const parsed = CreateBrand.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const { data: newId, error: rpcErr } = await sb.rpc('provision_brand', {
    p_name: input.name,
    p_slug: input.slug,
    p_domain: input.domain ?? null,
    p_logo_url: input.logo_url ?? null,
    p_primary_color: input.primary_color ?? null,
    p_support_email_display_name: input.support_email_display_name ?? null,
    p_ai_credits_micro: input.ai_credits_micro,
    p_auto_reply_min_confidence: input.auto_reply_min_confidence,
    p_auto_reply_categories: input.auto_reply_categories,
  });
  if (rpcErr) {
    const status = pgErrorToStatus(rpcErr.code);
    return c.json({ error: rpcErr.message, code: rpcErr.code }, status as 400 | 409 | 500);
  }
  const workspaceId = newId as unknown as string;

  await writeAudit(sb, {
    workspaceId,
    actorUserId,
    action: 'brand.created',
    targetType: 'workspace',
    targetId: workspaceId,
    metadata: { slug: input.slug, domain: input.domain ?? null },
  });

  const { data: brand, error: gErr } = await sb
    .from('workspaces')
    .select(
      'id, slug, name, plan, logo_url, primary_color, support_email_display_name, ' +
        'ai_credits_micro, auto_reply_min_confidence, auto_reply_categories, ' +
        'suspended_at, is_unrouted_bucket, created_at, updated_at',
    )
    .eq('id', workspaceId)
    .single();
  if (gErr) return c.json({ error: gErr.message, workspace_id: workspaceId }, 500);

  return c.json({ brand }, 201);
});

// GET /api/v1/god/brands — list all brands (excluding system rows).
god.get('/brands', async (c) => {
  const sb = c.get('sb');

  const { data, error } = await sb
    .from('workspaces')
    .select(
      'id, slug, name, plan, logo_url, primary_color, ai_credits_micro, ' +
        'suspended_at, created_at, updated_at',
    )
    .eq('is_unrouted_bucket', false)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ brands: data ?? [] });
});

// GET /api/v1/god/brands/:id — single brand detail with related counts.
god.get('/brands/:id', async (c) => {
  const sb = c.get('sb');
  const id = c.req.param('id');

  const { data: brand, error: bErr } = await sb
    .from('workspaces')
    .select(
      'id, slug, name, plan, logo_url, primary_color, support_email_display_name, ' +
        'ai_credits_micro, auto_reply_min_confidence, auto_reply_categories, ' +
        'suspended_at, is_unrouted_bucket, created_at, updated_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (bErr) return c.json({ error: bErr.message }, 500);
  if (!brand) return c.json({ error: 'Not found' }, 404);

  const { data: domains, error: dErr } = await sb
    .from('workspace_email_domains')
    .select('id, domain, verified_at, postmark_domain_id, created_at')
    .eq('workspace_id', id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (dErr) return c.json({ error: dErr.message }, 500);

  // Use head=true count queries for the cheap aggregations — no row data needed.
  const [ticketCount, memberCount] = await Promise.all([
    sb.from('tickets').select('id', { count: 'exact', head: true })
      .eq('workspace_id', id).is('deleted_at', null),
    sb.from('workspace_members').select('user_id', { count: 'exact', head: true })
      .eq('workspace_id', id).eq('active', true),
  ]);

  return c.json({
    brand,
    domains: domains ?? [],
    counts: {
      tickets: ticketCount.count ?? 0,
      members: memberCount.count ?? 0,
    },
  });
});

// PATCH /api/v1/god/brands/:id — edit brand fields.
god.patch('/brands/:id', async (c) => {
  const sb = c.get('sb');
  const actorUserId = c.get('userId');
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = UpdateBrand.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  // Convert the suspended_at sugar into a real timestamp value (or null).
  const update: Record<string, unknown> = {};
  if (input.name !== undefined)                       update.name = input.name;
  if (input.logo_url !== undefined)                   update.logo_url = input.logo_url;
  if (input.primary_color !== undefined)              update.primary_color = input.primary_color;
  if (input.support_email_display_name !== undefined) update.support_email_display_name = input.support_email_display_name;
  if (input.ai_credits_micro !== undefined)           update.ai_credits_micro = input.ai_credits_micro;
  if (input.auto_reply_min_confidence !== undefined)  update.auto_reply_min_confidence = input.auto_reply_min_confidence;
  if (input.auto_reply_categories !== undefined)      update.auto_reply_categories = input.auto_reply_categories;
  if (input.suspended_at !== undefined) {
    update.suspended_at = input.suspended_at === 'now' ? new Date().toISOString() : input.suspended_at;
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: 'No editable fields supplied' }, 400);
  }

  // Refuse to touch the unrouted bucket via the god API — it's a system row.
  const { data: existing, error: exErr } = await sb
    .from('workspaces')
    .select('is_unrouted_bucket')
    .eq('id', id)
    .maybeSingle();
  if (exErr) return c.json({ error: exErr.message }, 500);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.is_unrouted_bucket) {
    return c.json({ error: 'Cannot modify system workspace' }, 403);
  }

  const { data: brand, error: uErr } = await sb
    .from('workspaces')
    .update(update)
    .eq('id', id)
    .select(
      'id, slug, name, plan, logo_url, primary_color, support_email_display_name, ' +
        'ai_credits_micro, auto_reply_min_confidence, auto_reply_categories, ' +
        'suspended_at, is_unrouted_bucket, created_at, updated_at',
    )
    .single();
  if (uErr) return c.json({ error: uErr.message }, 500);

  await writeAudit(sb, {
    workspaceId: id,
    actorUserId,
    action: input.suspended_at !== undefined
      ? (update.suspended_at === null ? 'brand.unsuspended' : 'brand.suspended')
      : 'brand.updated',
    targetType: 'workspace',
    targetId: id,
    metadata: { changed_fields: Object.keys(update) },
  });

  return c.json({ brand });
});
