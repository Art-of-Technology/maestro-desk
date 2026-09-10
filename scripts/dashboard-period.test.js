import { describe, expect, test } from 'bun:test';
import { reportingPeriod } from '../web/js/dashboard/period.js';

describe('calendar reporting periods', () => {
  const now = new Date(2026, 0, 1, 13);
  test('today and yesterday cross year boundaries', () => {
    expect(reportingPeriod('today', null, null, now).firstDay).toBe('2026-01-01');
    expect(reportingPeriod('yesterday', null, null, now).lastDay).toBe('2025-12-31');
  });
  test('weeks begin Monday, including when today is Sunday', () => {
    const period = reportingPeriod('this-week', null, null, new Date(2026, 0, 4));
    expect([period.firstDay, period.lastDay]).toEqual(['2025-12-29', '2026-01-04']);
    expect(reportingPeriod('last-week', null, null, now).firstDay).toBe('2025-12-22');
  });
  test('calendar months and leap days', () => {
    expect(reportingPeriod('last-month', null, null, now).firstDay).toBe('2025-12-01');
    expect(reportingPeriod('this-month', null, null, new Date(2024, 1, 12)).lastDay).toBe('2024-02-29');
  });
  test('custom end is inclusive, SQL end is next local midnight', () => {
    const period = reportingPeriod('custom', '2026-03-29', '2026-03-29');
    expect(period.lastDay).toBe('2026-03-29');
    expect(new Date(period.end).getDate()).toBe(30);
    expect(new Date(period.end).getHours()).toBe(0);
  });
  test('reject missing, impossible and reversed dates', () => {
    for (const [from, to] of [['', '2026-01-01'], ['2026-02-30','2026-03-01'], ['2026-05-02','2026-05-01']]) {
      expect(() => reportingPeriod('custom', from, to)).toThrow();
    }
  });
  test('UK DST days retain local midnight boundaries (23 and 25 hours)', () => {
    const module = new URL('../web/js/dashboard/period.js', import.meta.url).href;
    const result = Bun.spawnSync([process.execPath, '--eval', `import { reportingPeriod } from ${JSON.stringify(module)};
      console.log(JSON.stringify(['2026-03-29','2026-10-25'].map(day => {
        const p = reportingPeriod('custom', day, day); return (new Date(p.end) - new Date(p.start)) / 3600000;
      })));`], { env: { ...process.env, TZ: 'Europe/London' } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual([23, 25]);
  });
});
