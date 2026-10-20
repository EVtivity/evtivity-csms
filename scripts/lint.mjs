#!/usr/bin/env node
/**
 * Run ESLint over the repository one package at a time.
 *
 * A single `eslint .` holds the type information of every package at once and
 * outgrew the 8 GB heap (OCPP 2.0.1 added a third generated validator set). One
 * process per package keeps each run well under that limit. The root files
 * outside packages/ (e2e/ and the root configs ESLint does not ignore) get one
 * run of their own.
 *
 * Usage: node scripts/lint.mjs [eslint options such as --fix or --quiet]
 * Exits non-zero when any run fails; every run still happens so all problems
 * are reported in one pass.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
const heap = '--max-old-space-size=8192';
const passThrough = process.argv.slice(2);

const packagesDir = join(root, 'packages');
const packages = readdirSync(packagesDir)
  .filter((name) => statSync(join(packagesDir, name)).isDirectory())
  .sort();

const runs = [
  // A checkout with nothing to lint outside packages/ (the public repo has no e2e/) is not an error.
  {
    label: 'root',
    args: ['--no-error-on-unmatched-pattern', '.', '--ignore-pattern', 'packages/**'],
  },
  ...packages.map((name) => ({ label: name, args: [join('packages', name)] })),
];

const failed = [];
for (const run of runs) {
  const result = spawnSync(process.execPath, [heap, eslint, ...run.args, ...passThrough], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0)
    failed.push(`${run.label} (exit ${String(result.status ?? result.signal)})`);
}

if (failed.length > 0) {
  console.error(`ESLint failed for: ${failed.join(', ')}`);
  process.exit(1);
}
