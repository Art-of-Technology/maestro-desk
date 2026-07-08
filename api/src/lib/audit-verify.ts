// Compliance check for the audit_events tamper-evidence installed in
// 20260623120000_audit_tamper_evident.sql: verify each workspace's per-workspace
// SHA-256 hash chain + contiguous seq, reporting any chain whose row was altered
// (hash break) or deleted (seq gap).
//
// Two entry points:
//   * verifyAuditChains()          — INCREMENTAL (daily). Resumes from a stored
//     per-workspace checkpoint (20260708130000), so cost ∝ rows added since last
//     run rather than the whole table. resetFirst:true forces a full re-verify
//     (weekly backstop). Advances checkpoints; writes to the DB.
//   * verifyAuditChainsFull()      — FULL, read-only (manual endpoint). Recomputes
//     every chain from genesis; no checkpoint writes.
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

type VerifyRow = { workspace_id: string; ok: boolean; first_bad_seq: string | null; first_bad_id: string | null };

// Map raw verifier rows → tampered list, and report any tampering (Sentry +
// live ops alert). Shared by the incremental and full paths. first_bad_seq is
// bigint → a string from postgres.js; Number() is safe (seq is a small
// per-workspace counter, nowhere near 2^53).
async function handleVerifyRows(rows: VerifyRow[]): Promise<{ checked: number; tampered: TamperedChain[] }> {
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
        `Audit-chain verification found ${tampered.length} workspace chain(s) that failed integrity ` +
        `verification — a row was altered or deleted. This should be impossible through the app ` +
        `(audit_events is append-only); it implies direct database access.\n\n` +
        `Affected (workspace_id @ first bad seq):\n` +
        tampered.map((t) => `  • ${t.workspaceId} @ seq ${t.firstBadSeq ?? '?'}`).join('\n'),
    });
  }

  return { checked: rows.length, tampered };
}

/**
 * Incremental audit-chain verification — the daily check. Resumes each
 * workspace's chain from its stored checkpoint (cost ∝ rows added since last
 * run) and advances the checkpoint on success. Pass `resetFirst: true` (weekly)
 * to wipe checkpoints first, forcing a full re-verify from genesis — the
 * backstop that catches a historical tamper below a checkpoint.
 */
export async function verifyAuditChains(
  opts: { resetFirst?: boolean } = {},
): Promise<{ checked: number; tampered: TamperedChain[] }> {
  const sql = getDb();
  let rows: VerifyRow[];
  if (opts.resetFirst) {
    // Wipe + full re-verify in ONE transaction: if the (unbounded) full scan
    // fails or the serverless function is killed mid-run, the checkpoint wipe
    // rolls back with it — so a failed weekly run can't leave checkpoints empty
    // and degrade every subsequent daily run into a full scan.
    rows = await sql.begin(async (tx) => {
      await tx`delete from audit_verify_checkpoints`;
      return tx<VerifyRow[]>`
        select workspace_id, ok, first_bad_seq, first_bad_id from audit_events_verify_incremental()
      `;
    }) as VerifyRow[];
  } else {
    rows = await sql<VerifyRow[]>`
      select workspace_id, ok, first_bad_seq, first_bad_id from audit_events_verify_incremental()
    `;
  }
  // Report OUTSIDE the transaction — Sentry + ops-alert do external I/O and their
  // own DB writes; they must not run inside the verify transaction.
  return handleVerifyRows(rows);
}

/**
 * Full, read-only audit-chain verification — recomputes every workspace's chain
 * from genesis and writes NO checkpoints. Used by the manual /audit-verify
 * endpoint so an ad-hoc audit is side-effect-free and independent of the
 * incremental checkpoints.
 */
export async function verifyAuditChainsFull(): Promise<{ checked: number; tampered: TamperedChain[] }> {
  const sql = getDb();
  const rows = await sql<VerifyRow[]>`
    select workspace_id, ok, first_bad_seq, first_bad_id from audit_events_verify()
  `;
  return handleVerifyRows(rows);
}
