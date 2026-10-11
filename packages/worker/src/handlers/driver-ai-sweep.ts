// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Cron `driver-ai-sweep` (every minute, plan v0.1.45 sections 2.2 and 2.4):
 *
 * - a case `queued` for over 2 minutes (its request was lost, P4) is queued
 *   again under the same job id, so a job that still exists is kept and the
 *   case gets one analysis in total;
 * - a case `analyzing` for over 10 minutes (a worker crashed mid-call) is put
 *   back to `queued` and queued again;
 * - a case `awaiting_feedback` longer than `driverAi.feedbackTimeoutHours`
 *   goes to operators as escalated/no_feedback (decision E6);
 * - backstop: a case still `queued` or `analyzing` 30 minutes after it was
 *   created goes to operators as failed/provider_error. Counted from
 *   `created_at`, not `updated_at`, because every re-queue and retry moves
 *   `updated_at`: the backstop bounds the whole AI step, so the case always
 *   reaches a person.
 *
 * Re-queues remove a finished job of the case first (`requeueDriverAiJob`):
 * BullMQ ignores an add under a retained job id.
 *
 * Every write is a compare-and-set in the support case service, so a rerun
 * changes nothing.
 */

import { client, getAiSettings } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import type { AiSettings } from '@evtivity/lib/ai-config';
import {
  escalateFromAi,
  requeueStuckDriverAiAnalysis,
} from '@evtivity/services/support-case.service';
import { requeueDriverAiJob } from '../driver-ai/queue.js';

export const DRIVER_AI_QUEUED_STALE_MS = 2 * 60_000;
export const DRIVER_AI_ANALYZING_STALE_MS = 10 * 60_000;
/** A case still queued or analyzing this long after creation goes to operators. */
export const DRIVER_AI_BACKSTOP_MS = 30 * 60_000;
/** Most cases of each kind handled per run; the next run takes the rest. */
const BATCH = 200;

export interface DriverAiSweepDeps {
  enqueue: (caseId: string) => Promise<void>;
  getSettings: () => Promise<AiSettings>;
  now: () => Date;
}

export interface DriverAiSweepResult {
  requeued: number;
  restarted: number;
  noFeedback: number;
  backstop: number;
}

async function caseIds(states: string[], column: string, before: Date): Promise<string[]> {
  const rows = await client<{ id: string }[]>`
    SELECT id FROM support_cases
    WHERE ai_state = ANY(${states}) AND status = 'ai_assist'
      AND ${client(column)} < ${before}
    ORDER BY ${client(column)} LIMIT ${BATCH}
  `;
  return rows.map((r) => r.id);
}

export async function runDriverAiSweep(
  deps: DriverAiSweepDeps,
  log: Logger,
): Promise<DriverAiSweepResult> {
  const now = deps.now().getTime();
  const result: DriverAiSweepResult = { requeued: 0, restarted: 0, noFeedback: 0, backstop: 0 };

  // Backstop first, so a case past it is not queued again.
  for (const id of await caseIds(
    ['queued', 'analyzing'],
    'created_at',
    new Date(now - DRIVER_AI_BACKSTOP_MS),
  )) {
    const escalated = await escalateFromAi({
      caseId: id,
      from: ['queued', 'analyzing'],
      state: 'failed',
      reason: 'provider_error',
      log,
    });
    if (escalated) result.backstop++;
  }

  for (const id of await caseIds(
    ['queued'],
    'updated_at',
    new Date(now - DRIVER_AI_QUEUED_STALE_MS),
  )) {
    await deps.enqueue(id);
    result.requeued++;
  }

  const analyzingBefore = new Date(now - DRIVER_AI_ANALYZING_STALE_MS);
  for (const id of await caseIds(['analyzing'], 'updated_at', analyzingBefore)) {
    if (await requeueStuckDriverAiAnalysis(id, analyzingBefore)) {
      await deps.enqueue(id);
      result.restarted++;
    }
  }

  const settings = await deps.getSettings();
  const timeoutMs = settings.driver.feedbackTimeoutHours * 3_600_000;
  for (const id of await caseIds(
    ['awaiting_feedback'],
    'ai_answered_at',
    new Date(now - timeoutMs),
  )) {
    const escalated = await escalateFromAi({
      caseId: id,
      from: ['awaiting_feedback'],
      state: 'escalated',
      reason: 'no_feedback',
      log,
    });
    if (escalated) result.noFeedback++;
  }
  return result;
}

export async function driverAiSweepHandler(log: Logger): Promise<void> {
  const result = await runDriverAiSweep(
    { enqueue: requeueDriverAiJob, getSettings: getAiSettings, now: () => new Date() },
    log,
  );
  if (Object.values(result).some((n) => n > 0)) {
    log.info(result, 'Driver AI cases swept');
  }
}
