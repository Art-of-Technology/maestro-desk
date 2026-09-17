import { describe, expect, it } from 'bun:test';
import { classifyLanguageDetection } from './lib/language-detection.js';
import { LanguageDetectionRange, languageDetectionReport } from './lib/language-detection-report.js';

it('classifies supported, unknown, empty and malformed detection responses', () => {
  expect(classifyLanguageDetection(' French\n')).toEqual({ outcome: 'success', failureCode: null });
  expect(classifyLanguageDetection('Unknown')).toEqual({ outcome: 'indeterminate', failureCode: 'unknown_language' });
  expect(classifyLanguageDetection('  ')).toEqual({ outcome: 'indeterminate', failureCode: 'empty_response' });
  expect(classifyLanguageDetection('Likely French')).toEqual({ outcome: 'indeterminate', failureCode: 'unsupported_response' });
});

it('accepts only bounded report ranges', () => {
  for (const range of ['7d', '30d', '90d', 'all']) expect(LanguageDetectionRange.safeParse(range).success).toBe(true);
  for (const range of ['1d', '365d', '', 'all-time']) expect(LanguageDetectionRange.safeParse(range).success).toBe(false);
});

(process.env.RUN_DB_TESTS ? describe : describe.skip)('language detection failure reporting', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let workspaceId: string;

  it('keeps workspaces isolated and excludes unclassified historical rows', async () => {
    sql = (await import('./lib/db.js')).getDb();
    const run = crypto.randomUUID();
    const [workspace] = await sql`select provision_brand(${'detection-report-' + run}, 'Detection report') as id`;
    const [other] = await sql`select provision_brand(${'detection-report-other-' + run}, 'Other report') as id`;
    workspaceId = workspace.id;
    try {
      await sql`insert into ai_usage_log (workspace_id, action, model, outcome, failure_code, created_at)
        values (${workspaceId}, 'detect_language', 'claude-haiku-4-5', 'success', null, now()),
               (${workspaceId}, 'detect_language', 'claude-haiku-4-5', 'indeterminate', 'unknown_language', now()),
               (${workspaceId}, 'detect_language', 'claude-haiku-4-5', 'failure', 'provider_error', now()),
               (${workspaceId}, 'detect_language', 'claude-haiku-4-5', null, null, now()),
               (${other.id}, 'detect_language', 'claude-haiku-4-5', 'failure', 'provider_error', now())`;
      const report = await languageDetectionReport(workspaceId, '7d');
      expect(report.summary).toMatchObject({ attempts: 3, failures: 2, successes: 1, providerFailures: 1, indeterminate: 1, failureRate: 66.7 });
      expect(report.reasons).toEqual([{ code: 'provider_error', count: 1 }, { code: 'unknown_language', count: 1 }]);
      expect(report.trend).toHaveLength(1);
    } finally {
      await sql`delete from workspaces where id in (${workspaceId}, ${other.id})`;
    }
  });
});
