// Daily compliance check for the audit_events tamper-evidence installed in
// 20260623120000_audit_tamper_evident.sql. audit_events_verify() recomputes
// each workspace's per-workspace SHA-256 hash chain and contiguous seq, and
// reports any chain whose row was altered (hash break) or deleted (seq gap).
// Read-only — safe to run as often as we like.
//
// On detection we report to Sentry (the platform's alert channel — DSN-gated,
// see lib/instrument.ts) AND log loudly to stderr. The payload is deliberately
// minimal: workspace ids + seq numbers only, never row contents or player PII,
// so it's safe to ship to Sentry even with the PII scrubber in place.

import { getDb } from './db.js';
import { captureException } from './instrument.js';
import { sendOpsAlert } from './alert.js';

export interface TamperedChain {
  workspaceId: string;
  // The earliest seq that failed verification (for a deleted row, the missing
  // seq); null only in the degenerate case the verifier can't localize it.
  firstBadSeq: number | null;
  firstBadId: string | null;
}

export async function verifyAuditChains(): Promise<{ checked: number; tampered: TamperedChain[] }> {
  const sql = getDb();
  const rows = await sql<
    { workspace_id: string; ok: boolean; first_bad_seq: string | null; first_bad_id: string | null }[]
  >`select workspace_id, ok, first_bad_seq, first_bad_id from audit_events_verify()`;

  // first_bad_seq is bigint → returned as a string by postgres.js; Number() is
  // safe (seq is a small per-workspace counter, nowhere near 2^53).
  const tampered: TamperedChain[] = rows
    .filter((r) => !r.ok)
    .map((r) => ({
      workspaceId: r.workspace_id,
      firstBadSeq: r.first_bad_seq == null ? null : Number(r.first_bad_seq),
      firstBadId: r.first_bad_id,
    }));

  if (tampered.length > 0) {
    console.error('[audit-verify] TAMPER DETECTED in audit_events:', JSON.stringify(tampered));
    captureException(
      new Error(`audit_events tamper detected in ${tampered.length} workspace chain(s)`),
      { tampered },
    );
    // Live alert. Signature keyed on the affected workspaces so a different set
    // re-alerts immediately rather than being suppressed by an earlier one.
    const workspaces = tampered.map((t) => t.workspaceId).sort();
    await sendOpsAlert({
      signature: `audit-tamper:${workspaces.join(',')}`,
      severity: 'critical',
      title: `Audit log tampering detected in ${tampered.length} workspace(s)`,
      detail:
        `audit_events_verify() found ${tampered.length} workspace chain(s) that failed integrity ` +
        `verification — a row was altered or deleted. This should be impossible through the app ` +
        `(audit_events is append-only); it implies direct database access.\n\n` +
        `Affected (workspace_id @ first bad seq):\n` +
        tampered.map((t) => `  • ${t.workspaceId} @ seq ${t.firstBadSeq ?? '?'}`).join('\n'),
    });
  }

  return { checked: rows.length, tampered };
}
