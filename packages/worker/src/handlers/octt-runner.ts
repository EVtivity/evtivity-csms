// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';
import { db, octtRuns, octtTestResults } from '@evtivity/database';
import { runCsTests, runTests } from '@evtivity/octt';
import type { OcppVersion, RunSummary, TestCaseResult } from '@evtivity/octt';
import type { Redis } from 'ioredis';
import { withLock } from '@evtivity/lib';
import type { RedisPubSubClient } from '@evtivity/lib';
import { config } from '../lib/config.js';

export interface OcttJobData {
  runId: number;
  ocppVersion: string;
  sutType: string;
}

/** Runs in progress in this process, aborted on shutdown so each restores its settings first. */
const activeRuns = new Set<AbortController>();

/**
 * Aborts the conformance runs of this process. Each stops starting tests,
 * restores the settings it changed, deletes its data and is marked failed.
 */
export function abortOcttRuns(reason: string): void {
  for (const controller of activeRuns) controller.abort(new Error(reason));
}

export async function octtRunnerHandler(
  data: OcttJobData,
  log: Logger,
  pubsub: RedisPubSubClient,
): Promise<void> {
  const { runId, ocppVersion, sutType } = data;

  // Mark run as running
  await db
    .update(octtRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(octtRuns.id, runId));

  const serverUrl = config.OCPP_SERVER_URL;
  const apiUrl = config.API_BASE_URL;

  const version = ocppVersion === 'all' ? undefined : (ocppVersion as OcppVersion);
  const controller = new AbortController();
  activeRuns.add(controller);
  try {
    const onResult = (result: TestCaseResult): void => {
      // Insert each test result as it completes. Wrapped to surface errors;
      // the insert + publish are non-critical to the run loop itself.
      void db
        .insert(octtTestResults)
        .values({
          runId,
          testId: result.testId,
          testName: result.testName,
          module: result.module,
          ocppVersion: result.version,
          status: result.result.status,
          durationMs: result.result.durationMs,
          steps: result.result.steps,
          error: result.result.error ?? null,
          notApplicableItem: result.result.notApplicable?.item ?? null,
          notApplicableReason: result.result.notApplicable?.reason ?? null,
        })
        .then(() =>
          pubsub.publish(
            'csms_events',
            JSON.stringify({
              eventType: 'octt.progress',
              runId,
              testId: result.testId,
              status: result.result.status,
            }),
          ),
        )
        .catch((err: unknown) => {
          log.warn(
            { err, runId, testId: result.testId },
            'Failed to persist OCTT test result or publish progress',
          );
        });
    };

    // A CS run tests the charging station simulator: each case starts its own
    // Test System server and simulator station in this process, as the CS CLI
    // does. A CSMS run drives the CSMS at OCPP_SERVER_URL and API_BASE_URL.
    const summary: RunSummary =
      sutType === 'cs'
        ? await runCsTests(
            { serverUrl: '', version, sut: 'cs', concurrency: 3, signal: controller.signal },
            onResult,
          )
        : await runTests(
            {
              serverUrl,
              apiUrl,
              version,
              sut: 'csms',
              concurrency: 3,
              ocspResponderUrl: config.OCTT_OCSP_RESPONDER_URL,
              signal: controller.signal,
            },
            onResult,
          );

    // Update run with final counts
    await db
      .update(octtRuns)
      .set({
        status: 'completed',
        totalTests: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
        errors: summary.errors,
        notApplicable: summary.notApplicable,
        durationMs: summary.durationMs,
        completedAt: new Date(),
      })
      .where(eq(octtRuns.id, runId));

    log.info({ runId, summary }, 'OCTT run completed');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      log.warn({ runId, error: errorMessage }, 'OCTT run aborted');
    } else {
      log.error({ runId, error: errorMessage }, 'OCTT run failed');
    }

    await db
      .update(octtRuns)
      .set({ status: 'failed', completedAt: new Date() })
      .where(eq(octtRuns.id, runId));
  } finally {
    activeRuns.delete(controller);
  }
}

/** Redis key held while a conformance run is in progress (ACL prefix `wkl:`). */
export const OCTT_RUN_LOCK_KEY = 'wkl:octt-run';

/** How long a queued run waits for the run in progress to finish. */
export const OCTT_RUN_LOCK_WAIT_MS = 24 * 60 * 60_000;

/**
 * Runs one conformance run at a time across worker replicas. The OCTT worker's
 * `concurrency: 1` holds per worker instance only, and two runs at once would
 * drive the same test stations. A queued run waits for the lock.
 */
export async function octtRunnerJob(
  lockRedis: Redis,
  data: OcttJobData,
  log: Logger,
  pubsub: RedisPubSubClient,
): Promise<void> {
  await withLock(lockRedis, OCTT_RUN_LOCK_KEY, () => octtRunnerHandler(data, log, pubsub), {
    acquireTimeoutMs: OCTT_RUN_LOCK_WAIT_MS,
  });
}
