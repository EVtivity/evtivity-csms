#!/usr/bin/env node
/**
 * Type-check the Playwright E2E code (e2e/, packages/csms/e2e/, packages/portal/e2e/,
 * playwright.config.ts) through e2e/tsconfig.json. `npm run typecheck` runs it after
 * `tsc -b`.
 *
 * The E2E suite is not part of every checkout. Without e2e/tsconfig.json there is
 * nothing to check and the script exits 0, so `npm run typecheck` works in a
 * checkout without the suite.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(root, 'e2e', 'tsconfig.json');

if (!existsSync(project)) {
  console.log('typecheck-e2e: no e2e/tsconfig.json, skipped');
  process.exit(0);
}

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '-b', project], { stdio: 'inherit' });
process.exit(result.status ?? 1);
