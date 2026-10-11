// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  getAiWorkerSettings,
  getOpsAiSettings,
  getStaleSessionTimeoutHours,
} from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import { quarterHourPeriod, scopeOfSite } from '@evtivity/services/ai-workers/runs';
import {
  effectiveIdleMinutes,
  sitesWithStuckSessions,
} from '@evtivity/services/ai-workers/stuck-sessions';
import { enqueueAiWorkerRun } from '../ai-worker-queue.js';

/**
 * Cron `ai-stuck-sessions` (every 15 minutes): one run per site (or the
 * unsited stations) that has a stuck session now. Off unless `opsAi.enabled`
 * and `aiWorkers.stuckSessions.enabled` are on (decision D4).
 */
export async function aiStuckSessionsHandler(log: Logger, now = new Date()): Promise<void> {
  const [ops, workers] = await Promise.all([getOpsAiSettings(), getAiWorkerSettings()]);
  if (!ops.enabled || !workers.stuckSessionsEnabled) return;
  const staleTimeoutHours = await getStaleSessionTimeoutHours();
  const siteIds = await sitesWithStuckSessions({
    idleMinutes: effectiveIdleMinutes(workers.stuckSessionsIdleMinutes, staleTimeoutHours),
    staleTimeoutHours,
  });
  const period = quarterHourPeriod(now);
  for (const siteId of siteIds) {
    await enqueueAiWorkerRun({ job: 'stuck_sessions', scope: scopeOfSite(siteId), siteId, period });
  }
  if (siteIds.length > 0) log.info({ scopes: siteIds.length, period }, 'Stuck-session runs queued');
}
