import { describe, expect, it } from 'bun:test';
import {
  detectResponsibleGamblingConcern,
  evaluateAutoReply,
  type WorkspaceAutoReplyConfig,
} from './auto-reply.js';
import type { TriageOutput } from './triage.js';

// Minimal TriageOutput stub — evaluateAutoReply only reads category_key +
// confidence. Cast through unknown so we don't have to fill the whole shape.
function triage(category_key: string, confidence: number): TriageOutput {
  return { category_key, confidence } as unknown as TriageOutput;
}

const enabled: WorkspaceAutoReplyConfig = {
  min_confidence: 85,
  categories: ['account', 'general'],
  name: 'Acme',
};

describe('detectResponsibleGamblingConcern', () => {
  it('flags self-exclusion language', () => {
    expect(detectResponsibleGamblingConcern(['Please self-exclude me'])).toBe(true);
    expect(detectResponsibleGamblingConcern(['can you close my account for good'])).toBe(true);
    expect(detectResponsibleGamblingConcern(['I signed up to GamStop'])).toBe(true);
  });

  it('flags gambling-harm and distress language', () => {
    expect(detectResponsibleGamblingConcern(['I think I have a gambling problem'])).toBe(true);
    expect(detectResponsibleGamblingConcern(['i am addicted to gambling'])).toBe(true);
    expect(detectResponsibleGamblingConcern(['I want to set a deposit limit'])).toBe(true);
    expect(detectResponsibleGamblingConcern(['I feel suicidal'])).toBe(true);
  });

  it('is case-insensitive and scans every supplied text', () => {
    expect(detectResponsibleGamblingConcern([null, 'all fine', 'SELF EXCLUSION please'])).toBe(true);
  });

  it('does not flag ordinary support questions', () => {
    expect(detectResponsibleGamblingConcern(['My deposit did not show up'])).toBe(false);
    expect(detectResponsibleGamblingConcern(['How do I withdraw my winnings?'])).toBe(false);
    expect(detectResponsibleGamblingConcern([null, undefined, ''])).toBe(false);
  });
});

describe('evaluateAutoReply RG gate', () => {
  it('holds for a human even at high confidence when a concern is present', () => {
    const d = evaluateAutoReply(triage('account', 99), enabled, true);
    expect(d.eligible).toBe(false);
    expect(d.eligible === false && d.reason).toBe('responsible_gambling_hold');
  });

  it('passes when there is no concern and all other gates clear', () => {
    const d = evaluateAutoReply(triage('account', 90), enabled, false);
    expect(d.eligible).toBe(true);
  });

  it('RG concern does not override workspace_disabled / category gates', () => {
    const disabled: WorkspaceAutoReplyConfig = { min_confidence: null, categories: [], name: 'Acme' };
    expect(evaluateAutoReply(triage('account', 99), disabled, true).reason).toBe('workspace_disabled');
    expect(evaluateAutoReply(triage('billing', 99), enabled, true).reason).toBe('category_not_allowed');
  });

  it('RG hold takes precedence over a low-confidence result', () => {
    // Concern present AND confidence below threshold → reason is the RG hold.
    expect(evaluateAutoReply(triage('account', 10), enabled, true).reason).toBe('responsible_gambling_hold');
  });

  it('defaults rgConcern to false (back-compatible 2-arg call)', () => {
    expect(evaluateAutoReply(triage('account', 90), enabled).eligible).toBe(true);
  });
});
