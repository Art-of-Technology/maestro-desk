import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { configureRuntimeAccess } from './lib/runtime-access.js';
import { safeError } from '../src/lib/diagnostics.js';

const { values } = parseArgs({
  options: {
    role: { type: 'string' },
    database: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
});
const url = process.env.DATABASE_URL;
if (!url || !values.role || !values.database)
  throw Error(
    'Set operator DATABASE_URL and supply --role LOGIN --database NAME [--apply]',
  );
const sql = postgres(url, {
  max: 1,
  prepare: false,
  ssl: url.includes('sslmode=disable') ? false : 'require',
  onnotice: () => {},
});
try {
  console.log(
    JSON.stringify(
      await configureRuntimeAccess(
        sql,
        values.role,
        values.database,
        values.apply,
      ),
    ),
  );
} catch (error) {
  console.error('Runtime permission configuration failed.', safeError(error));
  process.exitCode = 1;
} finally {
  await sql.end();
}
