import { getDb } from './db.js';

// Coarse "is this agent currently in the app?" check, backed by
// users.last_active_at (stamped from the ~60s list-sync poll on every page).
// Drives offline-notification routing: an agent active within the window is
// "online" and already covered by the in-app toast/bell, so we don't also send
// them a push. A never-active user (null last_active_at) reads as offline.
//
// Default window 5 min tolerates a few missed 60s polls (sleep, tab throttle)
// before we treat the agent as gone.
export async function isUserActive(userId: string, windowSeconds = 300): Promise<boolean> {
  const sql = getDb();
  const [row] = await sql<{ active: boolean }[]>`
    select (last_active_at is not null
            and last_active_at >= now() - make_interval(secs => ${windowSeconds})) as active
    from users where id = ${userId}
  `;
  return row?.active ?? false;
}
