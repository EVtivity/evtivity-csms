// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import pino from 'pino';
import { runTests } from './runner.js';
import { abortOnSignals, SIGNAL_EXIT_CODE } from './abort-on-signal.js';
import type { OcppVersion, SutType } from './types.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const serverUrl = getArg(args, '--server') ?? 'ws://localhost:7103';
  const version = getArg(args, '--version') as OcppVersion | undefined;
  const sut = (getArg(args, '--sut') as SutType | undefined) ?? 'csms';
  const module = getArg(args, '--module');
  const testArg = getArg(args, '--test');
  const testIds = testArg
    ?.split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  const concurrency = Number(getArg(args, '--concurrency') ?? '10');
  const password = getArg(args, '--password');
  const tlsServerUrl = getArg(args, '--tls-server');
  const tlsCaFile = getArg(args, '--tls-ca');
  const tlsCaCert = tlsCaFile != null ? readFileSync(tlsCaFile, 'utf8') : undefined;
  const ocspResponderUrl = getArg(args, '--ocsp-responder');
  const apiUrl =
    getArg(args, '--api-url') ?? process.env['OCTT_API_URL'] ?? 'http://localhost:7102';

  let logger: pino.Logger;
  try {
    logger = pino({ transport: { target: 'pino-pretty' } });
  } catch (err) {
    logger = pino({ level: 'info' });
    logger.warn({ err }, 'pino-pretty is not available, logging plain JSON');
  }
  logger.info({ serverUrl, version, sut, module, concurrency }, 'Starting OCTT runner');

  // 2.1 and 2.0.1 cases share ids, so each result line and count names its version.
  const byVersion = new Map<string, Record<string, number>>();

  const controller = new AbortController();
  abortOnSignals(controller, { logger, exit: (code) => process.exit(code) });

  const run = runTests(
    {
      serverUrl,
      version,
      sut,
      module,
      testIds,
      concurrency,
      password,
      apiUrl,
      tlsServerUrl,
      tlsCaCert,
      ocspResponderUrl,
      signal: controller.signal,
    },
    (result) => {
      const icons: Record<string, string> = {
        passed: 'PASS',
        failed: 'FAIL',
        skipped: 'SKIP',
        error: 'ERR ',
        notApplicable: 'N/A ',
      };
      const colors: Record<string, string> = {
        passed: '\x1b[32m',
        failed: '\x1b[31m',
        skipped: '\x1b[33m',
        error: '\x1b[31m',
        notApplicable: '\x1b[90m',
      };
      const counts = byVersion.get(result.version) ?? {};
      counts[result.result.status] = (counts[result.result.status] ?? 0) + 1;
      byVersion.set(result.version, counts);
      const icon = icons[result.result.status] ?? 'FAIL';
      const color = colors[result.result.status] ?? '\x1b[31m';
      const reset = '\x1b[0m';
      console.log(
        `${color}[${icon}]${reset} ${result.testId} (${result.version}) - ${result.testName} (${String(result.result.durationMs)}ms)`,
      );
      if (result.result.error != null) {
        console.log(`       Error: ${result.result.error}`);
      }
      if (result.result.notApplicable != null) {
        console.log(`       Reason: ${result.result.notApplicable.reason}`);
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
  let summary: Awaited<typeof run>;
  try {
    summary = await run;
  } catch (err) {
    if (!controller.signal.aborted) throw err;
    logger.warn({ err }, 'Run stopped by a signal after its cleanup');
    process.exit(SIGNAL_EXIT_CODE);
  }

  console.log('\n--- Summary ---');
  console.log(`Total: ${String(summary.total)}`);
  console.log(`Passed: ${String(summary.passed)}`);
  console.log(`Failed: ${String(summary.failed)}`);
  console.log(`Skipped: ${String(summary.skipped)}`);
  console.log(`Errors: ${String(summary.errors)}`);
  console.log(`Not applicable (PICS): ${String(summary.notApplicable)}`);
  console.log(`Duration: ${String(summary.durationMs)}ms`);
  for (const [v, counts] of byVersion) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const n = (status: string): string => String(counts[status] ?? 0);
    console.log(
      `Version ${v}: total ${String(total)}, passed ${n('passed')}, failed ${n('failed')}, skipped ${n('skipped')}, errors ${n('error')}, not applicable ${n('notApplicable')}`,
    );
  }

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
