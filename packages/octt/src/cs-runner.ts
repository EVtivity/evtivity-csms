// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import pino from 'pino';
import type { RunConfig, RunSummary } from './types.js';
import type { CsTestCase, CsTestCaseResult } from './cs-types.js';
import { getCsRegistry } from './cs-registry.js';
import { executeCsTest, closeCsSql } from './cs-executor.js';

const DEFAULT_CONCURRENCY = 3;

export async function runCsTests(
  config: RunConfig,
  onResult: (result: CsTestCaseResult) => void,
): Promise<RunSummary> {
  const logger = pino({ level: config.logLevel ?? 'info' });
  const allTests = getCsRegistry();
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;

  const tests = allTests.filter((tc) => {
    if (config.version != null && tc.version !== config.version) return false;
    if (config.module != null && tc.module !== config.module) return false;
    if (config.testIds != null && !config.testIds.includes(tc.id)) return false;
    return true;
  });

  logger.info({ total: tests.length, concurrency }, 'Starting CS test run');

  const summary: RunSummary = {
    total: tests.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
    durationMs: 0,
  };

  const start = Date.now();

  const queue = [...tests];
  const running: Promise<void>[] = [];

  while (queue.length > 0 || running.length > 0) {
    while (running.length < concurrency && queue.length > 0) {
      const testCase = queue.shift();
      if (testCase == null) break;
      const promise = processTest(testCase, config, logger, summary, onResult).then(() => {
        const idx = running.indexOf(promise);
        if (idx !== -1) void running.splice(idx, 1);
      });
      running.push(promise);
    }
    if (running.length > 0) {
      await Promise.race(running);
    }
  }

  summary.durationMs = Date.now() - start;
  await closeCsSql();
  return summary;
}

async function processTest(
  testCase: CsTestCase,
  config: RunConfig,
  logger: pino.Logger,
  summary: RunSummary,
  onResult: (result: CsTestCaseResult) => void,
): Promise<void> {
  const result = await executeCsTest(testCase, config, logger);

  switch (result.result.status) {
    case 'passed':
      summary.passed++;
      break;
    case 'failed':
      summary.failed++;
      break;
    case 'skipped':
      summary.skipped++;
      break;
    case 'error':
      summary.errors++;
      break;
  }

  onResult(result);
}
