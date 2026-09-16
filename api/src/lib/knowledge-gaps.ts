import { createHash } from 'node:crypto';

export type GapTicket = {
  id: string; category_key: string | null; brand: string | null; jurisdiction: string | null;
  unanswered: boolean; weak: boolean;
};

export function gapGroups(tickets: GapTicket[]) {
  const groups = new Map<string, { key: string; category: string | null; brand: string | null; market: string | null; tickets: GapTicket[] }>();
  for (const ticket of tickets) {
    if (!ticket.unanswered && !ticket.weak) continue;
    const key = createHash('sha256').update(JSON.stringify([ticket.category_key, ticket.brand, ticket.jurisdiction])).digest('hex');
    let group = groups.get(key);
    if (!group) {
      group = { key, category: ticket.category_key, brand: ticket.brand, market: ticket.jurisdiction, tickets: [] };
      groups.set(key, group);
    }
    if (!group.tickets.some(t => t.id === ticket.id)) group.tickets.push(ticket);
  }
  return [...groups.values()].filter(g => g.tickets.length >= 2)
    .sort((a,b) => b.tickets.length-a.tickets.length || a.key.localeCompare(b.key));
}
