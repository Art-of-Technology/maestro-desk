// Confirm each request independently; keep failures available for retry.
// Sequential requests bound API load and let cancellation stop remaining work.
export async function saveBulkChanges({ tickets, save, validate, isCurrent, onSaved }) {
  const result = { saved: [], failed: [], cancelled: false };
  for (const ticket of tickets) {
    if (!isCurrent()) { result.cancelled = true; break; }
    try {
      const response = await save(ticket);
      if (!validate(response, ticket)) throw new Error('The server did not confirm this change. Please retry.');
    } catch (error) {
      if (!isCurrent()) { result.cancelled = true; break; }
      result.failed.push({ ticket, message: error?.message || 'Could not save this change.' });
      continue;
    }
    if (!isCurrent()) { result.cancelled = true; break; }
    onSaved(ticket);
    result.saved.push(ticket);
  }
  return result;
}
