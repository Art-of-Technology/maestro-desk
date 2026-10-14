import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Sql } from 'postgres';
import {
  applyAuditRepair,
  parseRepairProposal,
  readRepairReceipt,
  RepairRefusal,
} from './audit-repair.js';

// Never overwrite a receipt or silently accept a partially written file.
export function writeRepairEvidence(path: string, value: unknown) {
  // PostgreSQL jsonb reorders object keys. Compare the JSON value, not its
  // presentation, while continuing to reject partial or different receipts.
  const serialise = (input: unknown) =>
    JSON.stringify(
      input,
      (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
            )
          : item,
      2,
    ) + '\n';
  const text = serialise(value);
  let fd: number;
  if (existsSync(path)) {
    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new RepairRefusal(
          'Evidence file is incomplete or invalid JSON; preserve it and recover to a new directory',
        );
      throw error;
    }
    if (serialise(existing) !== text)
      throw new RepairRefusal(
        'Evidence file already exists with different or incomplete contents',
      );
    fd = openSync(path, 'r');
  } else {
    fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, text);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // POSIX also needs the directory entry flushed. Node cannot open directories
  // this way on Windows; independent receipt custody remains a release gate.
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}

export async function executeRecordedRepair(
  sql: Sql,
  input: unknown,
  directory: string,
  recoverOnly = false,
) {
  const p = parseRepairProposal(input);
  const finalPath = join(directory, p.request.operationId + '.committed.json');
  const saved = await readRepairReceipt(sql, p);
  if (saved) {
    writeRepairEvidence(finalPath, saved);
    return {
      status: 'receipt_recovered',
      operationId: p.request.operationId,
      receiptPath: finalPath,
    };
  }
  if (recoverOnly)
    throw new RepairRefusal(
      'No committed database receipt exists; no repair was attempted',
    );
  if (existsSync(finalPath))
    throw new RepairRefusal(
      'External receipt exists but database receipt is absent; investigate restore or custody mismatch',
    );
  writeRepairEvidence(
    join(directory, p.request.operationId + '.pending.json'),
    { status: 'pending', proposal: p },
  );
  const receipt = await applyAuditRepair(sql, p);
  // A write failure here does NOT mean rollback. --recover reads the committed
  // database receipt and writes it again without repeating the repair.
  writeRepairEvidence(finalPath, receipt);
  return {
    status: 'committed',
    operationId: p.request.operationId,
    receiptPath: finalPath,
  };
}
