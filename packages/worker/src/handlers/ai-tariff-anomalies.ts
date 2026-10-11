// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, sites, getAiWorkerSettings, getOpsAiSettings } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import { dayPeriod } from '@evtivity/services/ai-workers/runs';
import { enqueueAiWorkerRun } from '../ai-worker-queue.js';

/**
 * Cron `ai-tariff-anomalies` (daily 06:00): one findings run per site. Off
 * unless `opsAi.enabled` and `aiWorkers.tariffAnomalies.enabled` are on
 * (decision D4). Findings only, never a proposal.
 */
export async function aiTariffAnomaliesHandler(log: Logger, now = new Date()): Promise<void> {
  const [ops, workers] = await Promise.all([getOpsAiSettings(), getAiWorkerSettings()]);
  if (!ops.enabled || !workers.tariffAnomaliesEnabled) return;
  const period = dayPeriod(now);
  const rows = await db.select({ id: sites.id }).from(sites);
  for (const site of rows) {
    await enqueueAiWorkerRun({ job: 'tariff_anomalies', scope: site.id, siteId: site.id, period });
  }
  log.info({ sites: rows.length, period }, 'Tariff anomaly runs queued');
}
