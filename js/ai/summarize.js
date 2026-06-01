// ─── AI ticket summarization ─────────────────────────────────────────────────
// Generates an agent-friendly handoff summary from a ticket's message
// transcript. Result is cached on t.aiSummary along with the message count
// it covered, so the sidebar can show a "stale" hint when newer messages
// arrive.
//
// CURRENT_TICKET is read from core/state.js via the global lexical env.
// openTicket() is a direct ES import from tickets/detail.js. The
// detail module imports summarizeTicket from here — the cycle is
// tolerated because each binding is only used inside a function body
// (closure), never at module top level.

import { AI_API_KEY, callClaude } from './client.js';
import { openTicket } from '../tickets/detail.js';

export async function summarizeTicket(ticketId) {
  if (!AI_API_KEY) { alert('No Claude API key configured. Add one in Settings → AI Assistant.'); return; }
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t) return;
  const msgs = t.msgs || [];
  if (!msgs.length) { alert('Nothing to summarise yet — this ticket has no messages.'); return; }
  t.aiSummary = { ...(t.aiSummary || {}), summarizing: true };
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
  // Compose a compact transcript. Skip internal notes by default — the summary
  // is meant for the customer-facing thread; agents who want notes included
  // can re-summarise after the next reply.
  const cust = CUSTOMERS.find(c => c.id === t.customerId);
  const transcript = msgs.map((m, i) => {
    const who = m.r === 'customer' ? `Customer (${m.from})` : m.r === 'agent' ? `Agent ${m.from}` : m.r === 'note' ? `Note from ${m.from}` : m.r === 'ai' ? 'AI' : m.from;
    return `[${i + 1}] ${who}: ${m.tOriginal || m.t}`;
  }).join('\n\n');
  const prompt = `Ticket ${t.id} · ${t.subject}\nCustomer: ${cust ? cust.first + ' ' + cust.last : t.customerId}\nStatus: ${t.status} · Priority: ${t.priority} · Category: ${t.category}\n\n${transcript}\n\nSummarise the conversation for an agent inheriting this ticket. Reply with strict JSON only, in this shape:\n{\n  "tldr": "one or two sentences capturing the gist",\n  "issue": "what the customer needs in 8-15 words",\n  "done": "what's been done so far in 8-15 words",\n  "next": "the most likely next action the agent should take in 8-15 words"\n}\nDo not include any prose outside the JSON.`;
  try {
    const { text: raw } = await callClaude({
      system: 'You produce concise, agent-friendly handoff summaries for support tickets. Output strict JSON only.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 600,
    });
    let parsed = null;
    try {
      const trimmed = (raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      parsed = JSON.parse(trimmed);
    } catch (e) { parsed = null; }
    if (!parsed) {
      t.aiSummary = { error: 'Could not parse AI response', generatedAt: new Date().toISOString() };
    } else {
      t.aiSummary = {
        tldr: String(parsed.tldr || '').trim(),
        issue: String(parsed.issue || '').trim(),
        done: String(parsed.done || '').trim(),
        next: String(parsed.next || '').trim(),
        coveredMsgCount: msgs.length,
        generatedAt: new Date().toISOString(),
      };
    }
  } catch (e) {
    t.aiSummary = { error: 'AI request failed: ' + (e?.message || 'network error'), generatedAt: new Date().toISOString() };
  }
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
}

export function clearTicketSummary(ticketId) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t) return;
  delete t.aiSummary;
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
}
