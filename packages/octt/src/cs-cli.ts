// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import pino from 'pino';
import { runCsTests } from './cs-runner.js';
import type { OcppVersion } from './types.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const version = getArg(args, '--version') as OcppVersion | undefined;
  const module = getArg(args, '--module');
  const concurrency = Number(getArg(args, '--concurrency') ?? '3');
  const testIds = getArg(args, '--test-ids')?.split(',');

  let logger: pino.Logger;
  try {
    logger = pino({ transport: { target: 'pino-pretty' } });
  } catch {
    logger = pino({ level: 'info' });
  }
  logger.info({ version, module, concurrency }, 'Starting CS conformance test runner');

  const summary = await runCsTests(
    {
      serverUrl: '', // Not used for CS tests (server is created per test)
      version,
      sut: 'cs',
      module,
      concurrency,
      testIds,
    },
    (result) => {
      const icons: Record<string, string> = {
        passed: 'PASS',
        failed: 'FAIL',
        skipped: 'SKIP',
        error: 'ERR ',
      };
      const colors: Record<string, string> = {
        passed: '\x1b[32m',
        failed: '\x1b[31m',
        skipped: '\x1b[33m',
        error: '\x1b[31m',
      };
      const icon = icons[result.result.status] ?? 'FAIL';
      const color = colors[result.result.status] ?? '\x1b[31m';
      const reset = '\x1b[0m';
      console.log(
        `${color}[${icon}]${reset} ${result.testId} - ${result.testName} (${String(result.result.durationMs)}ms)`,
      );
      if (result.result.error != null) {
        console.log(`       Error: ${result.result.error}`);
      }
      for (const step of result.result.steps) {
        if (step.status === 'failed') {
          console.log(`       Step ${String(step.step)}: ${step.description}`);
          console.log(`         Expected: ${step.expected ?? ''}`);
          console.log(`         Actual:   ${step.actual ?? ''}`);
        }
      }
    },
  );

  console.log('\n--- CS Test Summary ---');
  console.log(`Total: ${String(summary.total)}`);
  console.log(`Passed: ${String(summary.passed)}`);
  console.log(`Failed: ${String(summary.failed)}`);
  console.log(`Skipped: ${String(summary.skipped)}`);
  console.log(`Errors: ${String(summary.errors)}`);
  console.log(`Duration: ${String(summary.durationMs)}ms`);

  process.exit(summary.failed + summary.errors > 0 ? 1 : 0);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
