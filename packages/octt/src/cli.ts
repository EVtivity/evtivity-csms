// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import pino from 'pino';
import { runTests } from './runner.js';
import type { OcppVersion, SutType } from './types.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const serverUrl = getArg(args, '--server') ?? 'ws://localhost:7103';
  const version = getArg(args, '--version') as OcppVersion | undefined;
  const sut = (getArg(args, '--sut') as SutType | undefined) ?? 'csms';
  const module = getArg(args, '--module');
  const concurrency = Number(getArg(args, '--concurrency') ?? '10');
  const password = getArg(args, '--password');
  const apiUrl =
    getArg(args, '--api-url') ?? process.env['OCTT_API_URL'] ?? 'http://localhost:7102';

  let logger: pino.Logger;
  try {
    logger = pino({ transport: { target: 'pino-pretty' } });
  } catch {
    logger = pino({ level: 'info' });
  }
  logger.info({ serverUrl, version, sut, module, concurrency }, 'Starting OCTT runner');

  const summary = await runTests(
    { serverUrl, version, sut, module, concurrency, password, apiUrl },
    (result) => {
      const icon = result.result.status === 'passed' ? 'PASS' : 'FAIL';
      const color = result.result.status === 'passed' ? '\x1b[32m' : '\x1b[31m';
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

  console.log('\n--- Summary ---');
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
