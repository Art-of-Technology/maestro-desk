export const PERIODS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['this-week', 'This week'],
  ['last-week', 'Last week'], ['this-month', 'This month'], ['last-month', 'Last month'],
  ['custom', 'Custom'],
];

export function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('Choose a start and end date.');
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(+date) || localDate(date) !== value) throw new Error('Choose valid dates.');
  return date;
}

// Calendar arithmetic preserves local midnights through DST. End is exclusive
// for SQL, but the date shown in the picker is inclusive. Weeks start Monday.
export function reportingPeriod(key, customStart, customEnd, now = new Date()) {
  let start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let end = new Date(start);
  end.setDate(end.getDate() + 1);
  if (key === 'yesterday') { start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); }
  else if (key === 'this-week' || key === 'last-week') {
    start.setDate(start.getDate() - (start.getDay() + 6) % 7 - (key === 'last-week' ? 7 : 0));
    end = new Date(start); end.setDate(end.getDate() + 7);
  } else if (key === 'this-month' || key === 'last-month') {
    start = new Date(now.getFullYear(), now.getMonth() - (key === 'last-month' ? 1 : 0), 1);
    end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  } else if (key === 'custom') {
    start = parseDay(customStart); end = parseDay(customEnd);
    if (end < start) throw new Error('End date must be on or after start date.');
    end.setDate(end.getDate() + 1);
  } else if (key !== 'today') throw new Error('Choose a reporting period.');
  const last = new Date(end); last.setDate(last.getDate() - 1);
  return { start: start.toISOString(), end: end.toISOString(), firstDay: localDate(start), lastDay: localDate(last) };
}
