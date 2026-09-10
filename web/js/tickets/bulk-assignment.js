// Keep requests sequential so large selections do not flood the API. Each
// result is confirmed independently; failed tickets can be retried alone.
export async function saveBulkAssignments({ tickets, agentId, save, isCurrent, onSaved }) {
  const result = { saved: [], failed: [], cancelled: false };
  for (const ticket of tickets) {
    if (!isCurrent()) { result.cancelled = true; break; }
    let response;
    try {
      response = await save(ticket, agentId);
      if (response?.ticket?.id !== (ticket._uuid || ticket.id)
          || response.ticket.assigned_user_id !== agentId) {
        throw new Error('The server did not confirm this assignment. Please retry.');
      }
    } catch (error) {
      if (!isCurrent()) { result.cancelled = true; break; }
      result.failed.push({ ticket, message: error?.message || 'Could not save assignment.' });
      continue;
    }
    if (!isCurrent()) { result.cancelled = true; break; }
    onSaved(ticket);
    result.saved.push(ticket);
  }
  return result;
}
