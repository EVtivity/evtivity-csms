// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { workerJobLogs } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/worker-logs` (`api/routes.md`, "List sorting"). The
 * default order stays the start time alone, as before sorting existed.
 */
export const workerLogListSort = defineListSort(
  {
    startedAt: workerJobLogs.startedAt,
    jobName: workerJobLogs.jobName,
    queue: workerJobLogs.queue,
    status: workerJobLogs.status,
    durationMs: workerJobLogs.durationMs,
  },
  {
    tieBreaker: workerJobLogs.id,
    defaultOrder: [desc(workerJobLogs.startedAt)],
  },
);
