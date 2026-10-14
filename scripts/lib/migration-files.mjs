// Shared by run-migrations.mjs, verify-migrations-applied.mjs and
// check-migrations.mjs: how a migration file is split, whether it runs in a
// transaction, and how it is applied and recorded.
//
// A file runs in one transaction unless its first line is the marker
// `-- evtivity:no-transaction`. Such a file exists for statements PostgreSQL
// refuses inside a transaction block, CREATE INDEX CONCURRENTLY and DROP INDEX
// CONCURRENTLY: building a unique index over a large table in the file
// transaction holds a SHARE lock that blocks every insert until the commit
// (about 10 s per million meter_values rows). Its statements run one by one,
// each committing on its own, still under the runner's advisory lock, and the
// file's hash is recorded only after the last one succeeded. A failure halfway
// leaves the hash unrecorded, so the next run executes the whole file again:
// every statement must be safe to rerun after a crash at any point.

import { createHash } from 'node:crypto';

export const NO_TRANSACTION_MARKER = '-- evtivity:no-transaction';
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** SHA-256 of the file text, the hash drizzle.__drizzle_migrations records. */
export function migrationHash(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

/** True when the file's first line is the no-transaction marker. */
export function isNoTransaction(contents) {
  const firstLine = contents.split('\n', 1)[0] ?? '';
  return firstLine.replace(/\r$/, '').trim() === NO_TRANSACTION_MARKER;
}

/**
 * Statements split on drizzle's breakpoint marker, never on ';' (DO $$ bodies
 * contain semicolons). Empty chunks are left out.
 */
export function splitStatements(contents) {
  return contents.split(STATEMENT_BREAKPOINT).filter((chunk) => chunk.trim().length > 0);
}

/** The chunk without `--` line comments, for the static checks below. */
function withoutLineComments(chunk) {
  return chunk
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const CONCURRENTLY = /\bINDEX\s+CONCURRENTLY\b/i;

/**
 * Problems in a migration file's form, empty when it is fine:
 * - the marker anywhere but the first line (it would be ignored there);
 * - a CONCURRENTLY statement in a transactional file (PostgreSQL refuses it);
 * - in a no-transaction file, a CONCURRENTLY statement that shares its chunk
 *   with another statement (a multi-statement query runs as one implicit
 *   transaction), a CREATE without IF NOT EXISTS or a DROP without IF EXISTS
 *   (a rerun after a crash must not fail).
 */
export function migrationFileProblems(contents) {
  const problems = [];
  const lines = contents.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes(NO_TRANSACTION_MARKER)) {
      problems.push(`line ${i + 1}: the no-transaction marker counts only on the first line`);
    }
  }
  const noTransaction = isNoTransaction(contents);
  for (const chunk of splitStatements(contents)) {
    const code = withoutLineComments(chunk).trim();
    if (!CONCURRENTLY.test(code)) continue;
    const head = code.replace(/\s+/g, ' ').slice(0, 80);
    if (!noTransaction) {
      problems.push(
        `"${head}": CONCURRENTLY needs a no-transaction file (first line ${NO_TRANSACTION_MARKER})`,
      );
      continue;
    }
    if (code.replace(/;\s*$/, '').includes(';')) {
      problems.push(`"${head}": a CONCURRENTLY statement must be alone between breakpoints`);
    }
    if (/^CREATE\b/i.test(code) && !/\bIF\s+NOT\s+EXISTS\b/i.test(code)) {
      problems.push(`"${head}": CREATE INDEX CONCURRENTLY needs IF NOT EXISTS`);
    }
    if (/^DROP\b/i.test(code) && !/\bIF\s+EXISTS\b/i.test(code)) {
      problems.push(`"${head}": DROP INDEX CONCURRENTLY needs IF EXISTS`);
    }
  }
  return problems;
}

/**
 * Applies one migration file and records its hash with the journal `when`.
 * A transactional file runs every statement and the record in one
 * transaction. A no-transaction file runs each statement on its own and
 * records the hash after the last one succeeded. `sql` is a postgres.js
 * client with max: 1, so the caller's session advisory lock covers it.
 */
export async function applyMigrationFile(sql, { contents, hash, when }) {
  const statements = splitStatements(contents);
  if (isNoTransaction(contents)) {
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
    await sql`
      INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
      VALUES (${hash}, ${when})
    `;
    return;
  }
  await sql.begin(async (tx) => {
    for (const statement of statements) {
      await tx.unsafe(statement);
    }
    await tx`
      INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
      VALUES (${hash}, ${when})
    `;
  });
}

/** Session advisory lock every migrator takes before reading what is pending. */
export async function lockMigrations(sql) {
  await sql`SELECT pg_advisory_lock(hashtext('evtivity:migrations'))`;
}
