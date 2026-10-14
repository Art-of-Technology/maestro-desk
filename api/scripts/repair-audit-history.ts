import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import {
  parseRepairProposal,
  previewAuditRepair,
  RepairRefusal,
} from './lib/audit-repair.js';
import {
  executeRecordedRepair,
  writeRepairEvidence,
} from './lib/repair-evidence.js';
import { safeError } from '../src/lib/diagnostics.js';

const { values } = parseArgs({
  options: {
    request: { type: 'string' },
    out: { type: 'string' },
    proposal: { type: 'string' },
    'receipt-dir': { type: 'string' },
    confirm: { type: 'string' },
    apply: { type: 'boolean', default: false },
    recover: { type: 'boolean', default: false },
  },
});
const url = process.env.DATABASE_URL;
if (!url)
  throw new RepairRefusal(
    'Set operator DATABASE_URL; do not use the API environment or login',
  );
const sql = postgres(url, {
  max: 1,
  prepare: false,
  ssl: url.includes('sslmode=disable') ? false : 'require',
  onnotice: () => {},
});
try {
  if (values.apply || values.recover) {
    if (
      !values.proposal ||
      !values['receipt-dir'] ||
      values.request ||
      values.out ||
      (values.apply && values.recover)
    )
      throw new RepairRefusal(
        'Use --apply OR --recover, --proposal FILE and --receipt-dir DIRECTORY',
      );
    const p = parseRepairProposal(
      JSON.parse(readFileSync(values.proposal, 'utf8')),
    );
    if (values.apply && values.confirm !== p.proposalHash)
      throw new RepairRefusal(
        'Applying requires --confirm with the reviewed proposal fingerprint',
      );
    console.log(
      JSON.stringify(
        await executeRecordedRepair(
          sql,
          p,
          values['receipt-dir'],
          values.recover,
        ),
      ),
    );
  } else {
    if (
      !values.request ||
      !values.out ||
      values.proposal ||
      values.confirm ||
      values['receipt-dir']
    )
      throw new RepairRefusal('Preview: --request FILE --out NEW_FILE');
    const p = await previewAuditRepair(
      sql,
      JSON.parse(readFileSync(values.request, 'utf8')),
    );
    writeRepairEvidence(values.out, p);
    console.log(
      JSON.stringify({
        mode: 'preview',
        proposalHash: p.proposalHash,
        rows: p.request.selectedIds.length,
        chainRows: p.snapshot.chainRows,
        excluded: p.request.excludedIds.length,
      }),
    );
  }
} catch (error) {
  console.error(
    'Audit repair stopped. Check the approved scope, evidence files and runbook. If apply was attempted, use --recover to establish commit status.',
    error instanceof RepairRefusal ? error.message : safeError(error),
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}
