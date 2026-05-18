#!/usr/bin/env node
/**
 * Verify every SQL file in packages/database/src/migrations is recorded in
 * drizzle.__drizzle_migrations on the connected database. Self-heals any
 * silently-skipped migrations (drizzle-kit's `when`-comparison bug on
 * preserved-volume upgrades) by applying the SQL inside a transaction and
 * recording the hash. Exits non-zero only on a true failure so docker-
 * compose's `service_completed_successfully` blocks dependent services
 * from starting against a stale schema.
 *
 * Usage (run from packages/database/, where postgres is in node_modules):
 *   node ../../scripts/verify-migrations-applied.mjs           # verify + self-heal
 *   node ../../scripts/verify-migrations-applied.mjs --dry-run # report drift only
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/database/src/migrations');

const DRY_RUN = process.argv.includes('--dry-run');

// Load .env if it exists so this script behaves like every other dev command
// (drizzle-kit handles it via its own config; this script previously errored
// out with "DATABASE_URL not set" on shells that hadn't `source`d the file).
const ENV_FILE = join(REPO_ROOT, '.env');
if (existsSync(ENV_FILE)) {
  const text = readFileSync(ENV_FILE, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m == null) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value.startsWith('#')) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// Fall back to the dev default that matches drizzle.config.ts so a fresh
// clone with neither shell env nor .env entry still verifies.
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://evtivity:evtivity@localhost:5433/evtivity';

const sqlFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const expected = sqlFiles.map((f) => {
  const body = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
  return {
    tag: f.replace(/\.sql$/, ''),
    body,
    hash: createHash('sha256').update(body).digest('hex'),
  };
});

const sql = postgres(DATABASE_URL, { max: 1 });

try {
  const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
  const applied = new Set(rows.map((r) => r.hash));
  // Preserve file order so trailing migrations apply in the right sequence
  // (later migrations may depend on earlier ones that drizzle also skipped).
  const missing = expected.filter((e) => !applied.has(e.hash));

  if (missing.length > 0) {
    if (DRY_RUN) {
      console.log(`verify-migrations-applied: ${missing.length} migration(s) drifted from drizzle:`);
      for (const m of missing) console.log(`  - ${m.tag} (sha256 ${m.hash.slice(0, 12)}...)`);
      console.log(`\n--dry-run: not applying. Re-run without --dry-run to repair.`);
      process.exit(0);
    }
    console.warn(
      `verify-migrations-applied: ${missing.length} migration(s) drizzle silently skipped, self-healing...`,
    );
    for (const m of missing) {
      console.warn(`  - applying ${m.tag} (sha256 ${m.hash.slice(0, 12)}...)`);
      // Each migration runs in its own transaction so a mid-batch failure
      // leaves the DB in a recoverable state with the just-applied rows
      // committed up to (but not including) the failure.
      await sql.begin(async (tx) => {
        // Strip drizzle's "--> statement-breakpoint" markers; postgres-js
        // sql.unsafe() executes the whole text as a single multi-statement
        // batch, which is what drizzle-kit migrate does internally.
        const body = m.body.replace(/-->\s*statement-breakpoint/g, '');
        await tx.unsafe(body);
        await tx`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${m.hash}, ${Date.now()})
          ON CONFLICT DO NOTHING
        `;
      });
    }
    console.warn(`verify-migrations-applied: self-healed ${missing.length} migration(s)`);
  }

  // Re-check after self-heal so docker-compose blocks if a heal failed.
  const recheckRows = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
  const recheckApplied = new Set(recheckRows.map((r) => r.hash));
  const stillMissing = expected.filter((e) => !recheckApplied.has(e.hash));
  if (stillMissing.length > 0) {
    console.error(
      `verify-migrations-applied: ${stillMissing.length} migration(s) still NOT applied after self-heal:`,
    );
    for (const m of stillMissing) console.error(`  - ${m.tag} (sha256 ${m.hash.slice(0, 12)}...)`);
    process.exit(1);
  }

  console.log(
    `verify-migrations-applied OK: ${expected.length} files all present in __drizzle_migrations`,
  );
} finally {
  await sql.end();
}
