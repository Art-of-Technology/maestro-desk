import { test, expect, mock } from 'bun:test';
let workspace = 'one', token = 'token', requests = [], renders = 0;
mock.module('../web/js/core/api-client.js', () => ({
  getJwt: () => token, getWorkspaceId: () => workspace,
  apiGet: path => new Promise((resolve,reject) => requests.push({path,resolve,reject})),
}));
const {getAgentReport,invalidateAgentReport} = await import('../web/js/agents/statistics.js');
const load = (range='30d',id) => getAgentReport(range,id,()=>renders++);
const flush = () => new Promise(resolve => setTimeout(resolve,0));
test('report cache isolates workspace, range and agent; stale results cannot repaint', async () => {
  const old = load(); expect(load()).toBe(old); expect(requests).toHaveLength(1);
  workspace='two'; const current = load();
  requests[0].resolve({total:999}); await flush(); expect(renders).toBe(0);
  requests[1].resolve({total:2}); await flush(); expect(renders).toBe(1); expect(current.data.total).toBe(2);
  const week=load('7d','agent-id'); expect(requests.at(-1).path).toContain('range=7d&agentId=agent-id');
  requests.at(-1).reject(new Error('Unavailable')); await flush(); expect(week.error).toBe('Unavailable'); expect(week.data).toBeNull();
  invalidateAgentReport(); expect(load('7d','agent-id')).not.toBe(week);
  token=null; expect(load()).toBeNull();
});
