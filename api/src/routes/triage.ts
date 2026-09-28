import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuth } from '../middleware/auth.js';
import { triageTicket, TriageError } from '../lib/triage.js';
import { BudgetExceededError } from '../lib/budget.js';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { enforceRateLimit } from '../lib/rate-limit.js';

export const triage = new Hono();

triage.use('*', requireAuth);

// POST /api/v1/tickets/:id/triage
//
// Mounted at the route group level so the path becomes
// /api/v1/tickets/:id/triage (the parent route in index.ts owns the prefix).
triage.on('POST', ['/', '/tags'], async (c) => {
  const ticketId = c.req.param('id') || '';
  if (!z.string().uuid().safeParse(ticketId).success) throw new HTTPException(400, { message: 'Invalid ticket id' });
  const tagsOnly = c.req.path.endsWith('/tags');
  if (tagsOnly) {
    const limited = await enforceRateLimit(c, { name: 'tag-suggestions',
      by: `${c.get('workspaceId')}:${c.get('userId')}`, max: 10, windowSeconds: 60, failClosed: true });
    if (limited) return limited;
  }

  try {
    const result = await triageTicket({
      ticketId,
      tagsOnly,
      workspaceId: c.get('workspaceId'),
      userId: c.get('userId'),
    });
    if (tagsOnly) {
      const tags = await getDb()`select tag, confidence, accepted from ticket_ai_tags
        where ticket_id = ${ticketId} and workspace_id = ${c.get('workspaceId')} order by confidence desc`;
      return c.json({ ai_tags: tags });
    }
    return c.json(result);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return c.json(
        {
          error: 'AI budget exhausted for this workspace',
          balance_micro: err.balanceMicro,
        },
        402,
      );
    }
    if (err instanceof TriageError) {
      return c.json({ error: err.message }, err.status as 400 | 404 | 500 | 502);
    }
    throw err;
  }
});
