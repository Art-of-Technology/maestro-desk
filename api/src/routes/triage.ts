import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuth } from '../middleware/auth.ts';
import { triageTicket, TriageError } from '../lib/triage.ts';
import { BudgetExceededError } from '../lib/budget.ts';

export const triage = new Hono();

triage.use('*', requireAuth);

// POST /api/v1/tickets/:id/triage
//
// Mounted at the route group level so the path becomes
// /api/v1/tickets/:id/triage (the parent route in index.ts owns the prefix).
triage.post('/', async (c) => {
  const ticketId = c.req.param('id');
  if (!ticketId) throw new HTTPException(400, { message: 'Missing ticket id' });

  try {
    const result = await triageTicket({
      ticketId,
      workspaceId: c.get('workspaceId'),
      userId: c.get('userId'),
      sb: null,   // migrated to Neon — triageTicket opens its own getDb()
    });
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
