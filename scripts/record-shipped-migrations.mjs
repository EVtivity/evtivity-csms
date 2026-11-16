#!/usr/bin/env node
// Records the migration files a stable release ships in
// packages/database/shipped-migrations.json, so the shipped migration guard
// test fails when one of them changes later.
//
// Usage: node scripts/record-shipped-migrations.mjs v0.1.52 [--migrations <dir>]
//
// --migrations reads the files from another folder, such as the migrations of
// the public release tag; the journal of that folder decides which files the
// release shipped. Default: packages/database/src/migrations.

import fs from 'node:fs';
import path from 'node:path';
import { migrationHash } from './lib/migration-files.mjs';
import { recordShippedMigrations } from './lib/shipped-migrations.mjs';

const args = process.argv.slice(2);
const version = args[0];
const at = args.indexOf('--migrations');
if (version == null || version.startsWith('--') || (at >= 0 && args[at + 1] == null)) {
  console.error(
    'Usage: node scripts/record-shipped-migrations.mjs <stable tag> [--migrations <dir>]',
  );
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, '..');
const folder =
  at >= 0 ? path.resolve(args[at + 1]) : path.join(root, 'packages/database/src/migrations');
const mapPath = path.join(root, 'packages/database/shipped-migrations.json');
const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
const shipped = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const hashOf = (tag) => {
  const file = path.join(folder, `${tag}.sql`);
  return fs.existsSync(file) ? migrationHash(fs.readFileSync(file, 'utf8')) : null;
};
const next = recordShippedMigrations(shipped, journal, hashOf, version);
fs.writeFileSync(mapPath, `${JSON.stringify(next, null, 2)}\n`);
console.log(`${version}: ${String(Object.keys(next[version]).length)} migration file(s) recorded`);
