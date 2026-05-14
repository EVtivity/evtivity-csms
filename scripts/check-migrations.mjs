#!/usr/bin/env node
/**
 * Validate the Drizzle migrations journal.
 *
 * Catches three classes of footgun:
 *   1. A SQL file on disk with no matching journal entry, or vice versa.
 *   2. Duplicate or non-sequential `idx` values.
 *   3. A `when` value that is not strictly greater than the previous entry.
 *
 * (3) is the one that bit us: drizzle-kit's migrator picks up a new migration
 * only when its `when` exceeds the latest already-applied row's `created_at`
 * in `__drizzle_migrations`. If `npm run generate` produced a `when` that
 * happened to be lower than a hand-set `when` on a previous migration, the
 * new migration is silently skipped on every migrate run.
 *
 * Usage:
 *   node scripts/check-migrations.mjs              # check only (exit 1 on failure)
 *   node scripts/check-migrations.mjs --fix-last   # auto-bump the LAST entry
 *                                                  # (safe: skips already-applied
 *                                                  #  migrations, only patches
 *                                                  #  what generate just produced)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/database/src/migrations');
const JOURNAL_PATH = join(MIGRATIONS_DIR, 'meta/_journal.json');

const fixLast = process.argv.includes('--fix-last');

if (!existsSync(JOURNAL_PATH)) {
  console.error(`Journal not found at ${JOURNAL_PATH}`);
  process.exit(1);
}

const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8'));
const entries = journal.entries ?? [];

const errors = [];
const fixes = [];

const sqlFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const tagToFile = new Map();
for (const f of sqlFiles) {
  tagToFile.set(f.replace(/\.sql$/, ''), f);
}

const seenIdx = new Set();
const seenTag = new Set();
let lastWhen = -Infinity;
let lastIdx = -1;

for (let i = 0; i < entries.length; i++) {
  const e = entries[i];

  if (seenIdx.has(e.idx)) {
    errors.push(`Duplicate idx ${e.idx} (tag: ${e.tag})`);
  }
  seenIdx.add(e.idx);

  if (seenTag.has(e.tag)) {
    errors.push(`Duplicate tag ${e.tag}`);
  }
  seenTag.add(e.tag);

  if (e.idx !== lastIdx + 1) {
    errors.push(
      `Non-sequential idx at position ${i}: expected ${lastIdx + 1}, got ${e.idx} (${e.tag})`,
    );
  }
  lastIdx = e.idx;

  if (!tagToFile.has(e.tag)) {
    errors.push(`Journal entry ${e.tag} has no matching SQL file in ${MIGRATIONS_DIR}`);
  }

  if (e.when <= lastWhen) {
    const isLast = i === entries.length - 1;
    if (fixLast && isLast) {
      const newWhen = lastWhen + 1;
      fixes.push(`Bumping ${e.tag} when from ${e.when} to ${newWhen} (was <= prev ${lastWhen})`);
      e.when = newWhen;
    } else {
      errors.push(
        `${e.tag} when (${e.when}) is not strictly greater than previous (${lastWhen}). ` +
          `drizzle-kit's migrator will silently skip this migration. ` +
          (isLast
            ? `Re-run with --fix-last to auto-correct.`
            : `This entry is not the latest, so --fix-last will not touch it. ` +
              `If it has already been applied to all environments, set its when to ` +
              `${lastWhen + 1} manually in meta/_journal.json.`),
      );
    }
  }
  lastWhen = e.when;
}

const journalTags = new Set(entries.map((e) => e.tag));
for (const tag of tagToFile.keys()) {
  if (!journalTags.has(tag)) {
    errors.push(`SQL file ${tag}.sql has no matching journal entry`);
  }
}

if (fixes.length > 0) {
  writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2) + '\n');
  for (const f of fixes) console.log(`fix: ${f}`);
}

if (errors.length > 0) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`\nMigrations check FAILED with ${errors.length} error(s).`);
  process.exit(1);
}

console.log(
  `Migrations check OK: ${entries.length} entries, ${sqlFiles.length} SQL files, ${
    fixes.length ? `${fixes.length} fix(es) applied` : 'no fixes needed'
  }`,
);
