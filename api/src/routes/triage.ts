import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuth } from '../middleware/auth.ts';
import { triageTicket, TriageError } from '../lib/triage.ts';

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
      sb: c.get('sb'),
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof TriageError) {
      return c.json({ error: err.message }, err.status as 400 | 404 | 500 | 502);
    }
    throw err;
  }
});
