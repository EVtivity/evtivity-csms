#!/usr/bin/env node
// Applies pending Drizzle migrations with ONE TRANSACTION PER FILE.
//
// drizzle-kit's migrator wraps the entire pending batch in a single
// transaction. PostgreSQL forbids using an enum value in the transaction
// that added it (ALTER TYPE ... ADD VALUE), so any migration that uses a
// value added by an EARLIER migration file works on upgraded databases
// (the ADD VALUE committed in a previous release's run) but fails on fresh
// installs, where every migration shares the batch transaction. Migration
// 0032 (adds 'pricing_assignment') + 0035 (selects by it) broke every
// fresh install this way. Shipped migrations are immutable, so the fix is
// here: per-file transactions commit each ADD VALUE before the next file
// runs, which is also what a fresh install replaying release history would
// have done.
//
// Tracking stays byte-compatible with drizzle-kit: same
// drizzle.__drizzle_migrations table, hash = SHA-256 of the file bytes,
// created_at = the journal `when`.
//
// A file is pending when its hash is not recorded yet, not when its `when`
// exceeds the latest applied created_at as drizzle-kit decides. The `when`
// rule silently skips a migration whose `when` is not above every applied
// one, e.g. after verify-migrations-applied.mjs self-healed a file, or when
// a deployment carries its own migrations next to the upstream ones. Hashes
// make the decision independent of `when` ordering. Pending files still run
// in journal order.
//
// Usage: node run-migrations.mjs [migrationsFolder]
//   migrationsFolder defaults to ./src/migrations relative to cwd.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import postgres from 'postgres';

const folder = path.resolve(process.argv[2] ?? './src/migrations');
const journalPath = path.join(folder, 'meta', '_journal.json');
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://evtivity:evtivity@localhost:5433/evtivity';
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

try {
  // Session lock so two migrators (a deploy and its rollback, or two
  // replicas starting at once) never apply the same files concurrently. The
  // second waits, then finds nothing pending. max: 1 keeps every query on
  // this session, and closing the connection releases the lock.
  await sql`SELECT pg_advisory_lock(hashtext('evtivity:migrations'))`;
  await sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`;
  await sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;

  const appliedRows = await sql`SELECT hash FROM "drizzle"."__drizzle_migrations"`;
  const appliedHashes = new Set(appliedRows.map((row) => row.hash));

  let applied = 0;
  for (const entry of journal.entries) {
    const filePath = path.join(folder, `${entry.tag}.sql`);
    const fileContents = fs.readFileSync(filePath, 'utf8');
    const hash = crypto.createHash('sha256').update(fileContents).digest('hex');
    if (appliedHashes.has(hash)) continue;
    // Statements are separated by drizzle's explicit marker, never by ';'
    // (DO $$ ... $$ bodies contain semicolons).
    const statements = fileContents.split('--> statement-breakpoint');

    await sql.begin(async (tx) => {
      for (const statement of statements) {
        if (statement.trim().length === 0) continue;
        await tx.unsafe(statement);
      }
      await tx`
        INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
        VALUES (${hash}, ${entry.when})
      `;
    });
    applied += 1;
    console.log(`applied ${entry.tag}`);
  }

  console.log(
    applied > 0 ? `migrations applied: ${applied}` : 'migrations up to date: nothing to apply',
  );
} catch (err) {
  console.error('migration failed:', err.message);
  if (err.cause) console.error('cause:', err.cause.message ?? err.cause);
  process.exitCode = 1;
} finally {
  await sql.end();
}
