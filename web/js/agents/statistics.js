import { apiGet, getJwt, getWorkspaceId } from '../core/api-client.js';

let report = null;
export function invalidateAgentReport() { report = null; }
export function getAgentReport(range, agentId, onChange) {
  if (!getJwt()) return null;
  const key = JSON.stringify([getJwt(), getWorkspaceId(), range, agentId]);
  if (report?.key === key) return report;
  const state = report = { key, loading: true, data: null, error: null };
  apiGet(`/api/v1/reports/agents?range=${range}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ''}`)
    .then(data => { state.data = data; })
    .catch(error => { state.error = error.message || 'Could not load agent statistics.'; })
    .finally(() => {
      state.loading = false;
      if (report === state && key === JSON.stringify([getJwt(), getWorkspaceId(), range, agentId])) onChange();
    });
  return state;
}
