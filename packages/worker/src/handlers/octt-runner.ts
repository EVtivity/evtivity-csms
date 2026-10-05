// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';
import { db, octtRuns, octtTestResults } from '@evtivity/database';
import { runTests } from '@evtivity/octt';
import type { OcppVersion, SutType } from '@evtivity/octt';
import type { RedisPubSubClient } from '@evtivity/lib';
import { config } from '../lib/config.js';

export interface OcttJobData {
  runId: number;
  ocppVersion: string;
  sutType: string;
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

  try {
    const summary = await runTests(
      {
        serverUrl,
        apiUrl,
        version: ocppVersion === 'all' ? undefined : (ocppVersion as OcppVersion),
        sut: sutType as SutType,
        concurrency: 3,
        ocspResponderUrl: config.OCTT_OCSP_RESPONDER_URL,
      },
      (result) => {
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
      },
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
    log.error({ runId, error: errorMessage }, 'OCTT run failed');

    await db
      .update(octtRuns)
      .set({ status: 'failed', completedAt: new Date() })
      .where(eq(octtRuns.id, runId));
  }
}
