import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const integrations = new Hono();

integrations.use('*', requireAuth);

// ─── Slack integration (one per workspace) ──────────────────────────────
//
// Read returns the row or { integration: null } when unconfigured.
// Write is PUT (upsert) — there's only ever one row per workspace so
// "create" and "update" collapse into a single shape.

const EVENT_NAMES = ['ticket.created', 'ticket.resolved', 'ticket.escalated', 'priority.urgent'] as const;

const SlackBody = z.object({
  webhook_url: z.string().url().startsWith('https://hooks.slack.com/'),
  channel:     z.string().max(80).nullable().optional(),
  active:      z.boolean().optional(),
  events:      z.array(z.enum(EVENT_NAMES)).min(1).max(EVENT_NAMES.length),
});

integrations.get('/slack', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const { data, error } = await sb
    .from('slack_integrations')
    .select('webhook_url, channel, active, events, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ integration: data || null });
});

integrations.put('/slack', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = SlackBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;
  const { data, error } = await sb
    .from('slack_integrations')
    .upsert(
      {
        workspace_id: workspaceId,
        webhook_url:  input.webhook_url,
        channel:      input.channel ?? null,
        active:       input.active ?? true,
        events:       input.events,
      },
      { onConflict: 'workspace_id' },
    )
    .select('webhook_url, channel, active, events, updated_at')
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ integration: data });
});

integrations.delete('/slack', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const { error } = await sb
    .from('slack_integrations')
    .delete()
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});
