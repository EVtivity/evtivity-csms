// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, sites, getAiWorkerSettings, getOpsAiSettings } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import { COMPANY_SCOPE, dayPeriod } from '@evtivity/services/ai-workers/runs';
import { enqueueAiWorkerRun } from '../ai-worker-queue.js';

/**
 * Cron `ai-network-summary` (daily 05:30): one run per site and one
 * company-level run for the day. Off unless `opsAi.enabled` and
 * `aiWorkers.networkSummary.enabled` are on (decision D4).
 */
export async function aiNetworkSummaryHandler(log: Logger, now = new Date()): Promise<void> {
  const [ops, workers] = await Promise.all([getOpsAiSettings(), getAiWorkerSettings()]);
  if (!ops.enabled || !workers.networkSummaryEnabled) return;
  const period = dayPeriod(now);
  const rows = await db.select({ id: sites.id }).from(sites);
  for (const site of rows) {
    await enqueueAiWorkerRun({ job: 'network_summary', scope: site.id, siteId: site.id, period });
  }
  await enqueueAiWorkerRun({ job: 'network_summary', scope: COMPANY_SCOPE, siteId: null, period });
  log.info({ sites: rows.length, period }, 'AI network summary runs queued');
}
