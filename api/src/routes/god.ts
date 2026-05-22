import { Hono } from 'hono';
import { z } from 'zod';
import { requirePlatformAdmin, writeAudit } from '../middleware/platform-admin.ts';
import {
  createDomain as pmCreateDomain,
  deleteDomain as pmDeleteDomain,
  verifyDomain as pmVerifyDomain,
  isFullyVerified,
  isPostmarkAccountConfigured,
  dnsRecommendations,
  PostmarkAccountError,
  PostmarkAccountNotConfiguredError,
  type PostmarkDomain,
} from '../lib/postmark-domains.ts';

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

// ─── Owner invite ──────────────────────────────────────────────────────────
//
// Invites a user as Admin of a brand. Uses Supabase's generateLink (not
// inviteUserByEmail) so we get a copy-paste magic link back instead of
// relying on SMTP being configured — the operator can paste it into Slack
// / email / wherever rather than depending on Supabase's mail delivery.
//
// On success: creates (or finds) the auth.users row, upserts public.users,
// inserts workspace_members with the brand's Admin role. Idempotent — re-
// calling generates a fresh link but leaves DB state stable.

const InviteOwner = z.object({ email: z.string().email() });

function deriveNameFromEmail(email: string): { name: string; initials: string } {
  const local = email.split('@')[0] || 'user';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : '');
  const first = cap(parts[0]) || 'User';
  const last = cap(parts[1] ?? '');
  const name = [first, last].filter(Boolean).join(' ');
  const initials = ((first[0] ?? '') + (last[0] ?? '')).toUpperCase() || first.slice(0, 2).toUpperCase();
  return { name, initials };
}

god.post('/brands/:id/invite', async (c) => {
  const sb = c.get('sb');
  const actorUserId = c.get('userId');
  const brandId = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = InviteOwner.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const email = parsed.data.email.toLowerCase();

  // 1. Verify brand + grab the Admin role id.
  const { data: brand, error: bErr } = await sb
    .from('workspaces')
    .select('id, name, is_unrouted_bucket')
    .eq('id', brandId)
    .maybeSingle();
  if (bErr) return c.json({ error: bErr.message }, 500);
  if (!brand) return c.json({ error: 'Brand not found' }, 404);
  if (brand.is_unrouted_bucket) return c.json({ error: 'Cannot invite to system workspace' }, 403);

  const { data: adminRole, error: rErr } = await sb
    .from('roles')
    .select('id')
    .eq('workspace_id', brandId)
    .eq('is_admin', true)
    .maybeSingle();
  if (rErr) return c.json({ error: rErr.message }, 500);
  if (!adminRole) return c.json({ error: 'Admin role missing on brand — provisioning corrupted' }, 500);

  // 2. Generate an invite link. Supabase creates the auth.users row if it
  // doesn't exist; if it does, the existing row is reused. Either way we
  // get a usable user_id back.
  const { data: linkData, error: lErr } = await sb.auth.admin.generateLink({
    type: 'invite',
    email,
  });
  if (lErr || !linkData?.user) {
    return c.json({ error: lErr?.message ?? 'Invite-link generation failed' }, 502);
  }
  const authUserId = linkData.user.id;
  const inviteLink = linkData.properties?.action_link ?? null;

  // 3. Upsert public.users — the FK target for workspace_members. Name +
  // initials are heuristic from the email local-part; the user can update
  // them via the profile screen once they sign in.
  const { name, initials } = deriveNameFromEmail(email);
  const { error: uErr } = await sb
    .from('users')
    .upsert(
      { id: authUserId, email, name, initials },
      { onConflict: 'id', ignoreDuplicates: false },
    );
  if (uErr) return c.json({ error: `users upsert failed: ${uErr.message}` }, 500);

  // 4. Upsert workspace_members — composite PK (workspace_id, user_id)
  // makes the upsert idempotent. If the user was previously a member with
  // a different role, this PROMOTES them to Admin — intentional, since the
  // operator explicitly invited them as owner.
  const { error: mErr } = await sb
    .from('workspace_members')
    .upsert(
      {
        workspace_id: brandId,
        user_id: authUserId,
        role_id: adminRole.id,
        active: true,
      },
      { onConflict: 'workspace_id,user_id', ignoreDuplicates: false },
    );
  if (mErr) return c.json({ error: `workspace_members upsert failed: ${mErr.message}` }, 500);

  await writeAudit(sb, {
    workspaceId: brandId,
    actorUserId,
    action: 'brand.owner_invited',
    targetType: 'workspace',
    targetId: brandId,
    metadata: { email, invited_user_id: authUserId },
  });

  return c.json({ user_id: authUserId, email, invite_link: inviteLink }, 201);
});

// ─── Domain provisioning ───────────────────────────────────────────────────
//
// Adding a domain to a brand is a two-system operation: we write a local
// workspace_email_domains row AND register the domain with Postmark to get
// DKIM + Return-Path DNS records back. The brand owner then pastes those
// records into their DNS, and the verify endpoint re-checks with Postmark.
//
// If POSTMARK_ACCOUNT_TOKEN is unset, the local row is still created (so
// inbound routing in PR D works as soon as the brand's MX is set), but
// postmark_domain_id stays null and outbound mail won't have proper DKIM.
// Hitting the verify endpoint later will trigger creation if missing.

const AddDomain = z.object({ domain: Domain });

// POST /api/v1/god/brands/:id/domains — add + provision a sender domain.
god.post('/brands/:id/domains', async (c) => {
  const sb = c.get('sb');
  const actorUserId = c.get('userId');
  const brandId = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = AddDomain.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const { domain } = parsed.data;

  // Reject the unrouted bucket — domains belong on real brands only.
  const { data: ws, error: wErr } = await sb
    .from('workspaces')
    .select('is_unrouted_bucket')
    .eq('id', brandId)
    .maybeSingle();
  if (wErr) return c.json({ error: wErr.message }, 500);
  if (!ws) return c.json({ error: 'Brand not found' }, 404);
  if (ws.is_unrouted_bucket) return c.json({ error: 'Cannot add domain to system workspace' }, 403);

  // Insert local row first. Unique violation (23505) on domain → 409.
  const { data: row, error: iErr } = await sb
    .from('workspace_email_domains')
    .insert({ workspace_id: brandId, domain })
    .select('id, domain, verified_at, postmark_domain_id, created_at')
    .single();
  if (iErr) {
    if (iErr.code === '23505') return c.json({ error: 'Domain already in use', code: iErr.code }, 409);
    return c.json({ error: iErr.message }, 500);
  }

  // Provision at Postmark if the account token is configured. Best-effort:
  // if Postmark refuses, we keep the local row + report the failure so the
  // operator can retry via the verify endpoint after fixing config.
  let postmarkDomain: PostmarkDomain | null = null;
  let postmarkError: string | null = null;
  if (isPostmarkAccountConfigured()) {
    try {
      postmarkDomain = await pmCreateDomain(domain);
      const { error: uErr } = await sb
        .from('workspace_email_domains')
        .update({ postmark_domain_id: String(postmarkDomain.ID) })
        .eq('id', row.id);
      if (uErr) console.error('[god/domains] postmark_domain_id update failed:', uErr.message);
    } catch (err) {
      postmarkError = err instanceof Error ? err.message : String(err);
      console.error(`[god/domains] Postmark createDomain failed for ${domain}: ${postmarkError}`);
    }
  }

  await writeAudit(sb, {
    workspaceId: brandId,
    actorUserId,
    action: 'brand.domain_added',
    targetType: 'workspace',
    targetId: brandId,
    metadata: {
      domain,
      domain_id: row.id,
      postmark_domain_id: postmarkDomain?.ID ?? null,
      postmark_error: postmarkError,
    },
  });

  return c.json({
    domain: { ...row, postmark_domain_id: postmarkDomain?.ID ? String(postmarkDomain.ID) : null },
    dns_setup: postmarkDomain ? dnsRecommendations(postmarkDomain) : null,
    postmark_configured: isPostmarkAccountConfigured(),
    postmark_error: postmarkError,
  }, 201);
});

// POST /api/v1/god/brands/:id/domains/:domainId/verify — re-check verification.
//
// Idempotent. If postmark_domain_id is missing (e.g. PM was down at create
// time), this also acts as a recovery hook — we create the Postmark domain
// now, then immediately verify.
god.post('/brands/:id/domains/:domainId/verify', async (c) => {
  const sb = c.get('sb');
  const actorUserId = c.get('userId');
  const brandId = c.req.param('id');
  const domainId = c.req.param('domainId');

  const { data: row, error: rErr } = await sb
    .from('workspace_email_domains')
    .select('id, workspace_id, domain, postmark_domain_id, verified_at')
    .eq('id', domainId)
    .eq('workspace_id', brandId)
    .is('deleted_at', null)
    .maybeSingle();
  if (rErr) return c.json({ error: rErr.message }, 500);
  if (!row) return c.json({ error: 'Domain not found' }, 404);

  if (!isPostmarkAccountConfigured()) {
    return c.json({ error: 'Postmark Domains API is not configured (POSTMARK_ACCOUNT_TOKEN unset)' }, 503);
  }

  let pmDomain: PostmarkDomain;
  try {
    if (!row.postmark_domain_id) {
      pmDomain = await pmCreateDomain(row.domain);
      const { error: uErr } = await sb
        .from('workspace_email_domains')
        .update({ postmark_domain_id: String(pmDomain.ID) })
        .eq('id', row.id);
      if (uErr) console.error('[god/domains] postmark_domain_id update failed:', uErr.message);
    } else {
      pmDomain = await pmVerifyDomain(Number(row.postmark_domain_id));
    }
  } catch (err) {
    if (err instanceof PostmarkAccountError) {
      return c.json({ error: err.message, postmark_status: err.httpStatus }, 502);
    }
    if (err instanceof PostmarkAccountNotConfiguredError) {
      return c.json({ error: err.message }, 503);
    }
    throw err;
  }

  // Stamp verified_at when both DKIM and Return-Path resolve. Once stamped,
  // leave it alone — re-verification doesn't reset the timestamp.
  const fullyVerified = isFullyVerified(pmDomain);
  if (fullyVerified && !row.verified_at) {
    const { error: vErr } = await sb
      .from('workspace_email_domains')
      .update({ verified_at: new Date().toISOString() })
      .eq('id', row.id);
    if (vErr) console.error('[god/domains] verified_at stamp failed:', vErr.message);

    await writeAudit(sb, {
      workspaceId: brandId,
      actorUserId,
      action: 'brand.domain_verified',
      targetType: 'workspace',
      targetId: brandId,
      metadata: { domain: row.domain, domain_id: row.id },
    });
  }

  return c.json({
    domain_id: row.id,
    domain: row.domain,
    fully_verified: fullyVerified,
    dkim_verified: pmDomain.DKIMVerified,
    return_path_verified: pmDomain.ReturnPathDomainVerified,
    dns_setup: dnsRecommendations(pmDomain),
  });
});

// DELETE /api/v1/god/brands/:id/domains/:domainId — offboard a sender domain.
//
// Soft-deletes locally so the (partial unique on (domain) where deleted_at
// is null) frees the domain string for re-use. Best-effort delete at
// Postmark — if they return 404 (already gone), we proceed; other failures
// are logged but don't block the local soft-delete (an orphaned Postmark
// row is recoverable manually).
god.delete('/brands/:id/domains/:domainId', async (c) => {
  const sb = c.get('sb');
  const actorUserId = c.get('userId');
  const brandId = c.req.param('id');
  const domainId = c.req.param('domainId');

  const { data: row, error: rErr } = await sb
    .from('workspace_email_domains')
    .select('id, workspace_id, domain, postmark_domain_id')
    .eq('id', domainId)
    .eq('workspace_id', brandId)
    .is('deleted_at', null)
    .maybeSingle();
  if (rErr) return c.json({ error: rErr.message }, 500);
  if (!row) return c.json({ error: 'Domain not found' }, 404);

  let pmDeleteError: string | null = null;
  if (row.postmark_domain_id && isPostmarkAccountConfigured()) {
    try {
      await pmDeleteDomain(Number(row.postmark_domain_id));
    } catch (err) {
      if (err instanceof PostmarkAccountError && err.httpStatus === 404) {
        // Already gone at Postmark — treat as success.
      } else {
        pmDeleteError = err instanceof Error ? err.message : String(err);
        console.error(`[god/domains] Postmark delete failed for ${row.domain}: ${pmDeleteError}`);
      }
    }
  }

  const { error: dErr } = await sb
    .from('workspace_email_domains')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', row.id);
  if (dErr) return c.json({ error: dErr.message }, 500);

  await writeAudit(sb, {
    workspaceId: brandId,
    actorUserId,
    action: 'brand.domain_removed',
    targetType: 'workspace',
    targetId: brandId,
    metadata: { domain: row.domain, domain_id: row.id, postmark_delete_error: pmDeleteError },
  });

  return c.json({ ok: true, postmark_delete_error: pmDeleteError });
});
