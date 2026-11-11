// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc, sql } from 'drizzle-orm';
import { ocpiSyncLog } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/ocpi/sync-log` (`api/routes.md`, "List sorting"). */
export const ocpiSyncLogListSort = defineListSort(
  {
    module: ocpiSyncLog.module,
    direction: ocpiSyncLog.direction,
    action: ocpiSyncLog.action,
    status: ocpiSyncLog.status,
    // Stored as text: compared as a number, a value that is no number sorts last.
    objectsCount: sql`case when ${ocpiSyncLog.objectsCount} ~ '^[0-9]{1,18}$' then ${ocpiSyncLog.objectsCount}::bigint end`,
    createdAt: ocpiSyncLog.createdAt,
  },
  {
    tieBreaker: ocpiSyncLog.id,
    defaultOrder: [desc(ocpiSyncLog.createdAt), desc(ocpiSyncLog.id)],
  },
);
