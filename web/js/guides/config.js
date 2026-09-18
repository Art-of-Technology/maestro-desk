export const GUIDE_STEPS = [
  {
    id: 'dashboard',
    page: 'dashboard',
    title: 'See what needs attention',
    body: 'Use the dashboard for today’s workload, replies, and team activity.',
    source: 'web/js/dashboard/index.js',
  },
  {
    id: 'tickets',
    page: 'tickets',
    title: 'Work through player requests',
    body: 'Open a ticket to reply, add a note, assign it, or change its status.',
    source: 'web/js/tickets/list.js',
  },
  {
    id: 'customers',
    page: 'customers',
    title: 'Understand the player',
    body: 'Find player details, previous tickets, and account context here.',
    source: 'web/js/customers/index.js',
  },
  {
    id: 'knowledge',
    page: 'kb',
    title: 'Find trusted answers',
    body: 'Search approved articles before replying to a player.',
    source: 'web/js/kb/index.js',
  },
  {
    id: 'agents',
    page: 'agents',
    title: 'See who is available',
    body: 'Review teammates, roles, workload, and availability.',
    source: 'web/js/agents/index.js',
  },
];

// Changing any guide step automatically gives it a new completion version.
export const GUIDE_VERSION = JSON.stringify(GUIDE_STEPS);

export function validateGuideConfig(steps = GUIDE_STEPS) {
  const ids = new Set();
  for (const step of steps) {
    if (!step.id || !step.page || !step.title || !step.body || !step.source) throw new Error('Every guide step needs an id, page, title, body, and source.');
    if (ids.has(step.id)) throw new Error(`Duplicate guide step: ${step.id}`);
    if (step.title.length > 40 || step.body.length > 100) throw new Error(`Guide copy is too long: ${step.id}`);
    ids.add(step.id);
  }
  return true;
}
