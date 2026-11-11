// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc, sql } from 'drizzle-orm';
import { accessLogs, drivers, users } from '@evtivity/database';
import { defineListSort, sortablePersonName } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/access-logs` (`api/routes.md`, "List sorting"). The user
 * sorts the way the tabs show it: the operator's or driver's name, else the email.
 */
export const accessLogListSort = defineListSort(
  {
    createdAt: accessLogs.createdAt,
    user: sql`coalesce(${sortablePersonName(
      sql`coalesce(${users.firstName}, ${drivers.firstName})`,
      sql`coalesce(${users.lastName}, ${drivers.lastName})`,
    )}, ${users.email}, ${drivers.email})`,
    action: accessLogs.action,
    remoteAddress: accessLogs.remoteAddress,
    apiKeyName: accessLogs.apiKeyName,
    method: accessLogs.method,
    path: accessLogs.path,
    statusCode: accessLogs.statusCode,
    durationMs: accessLogs.durationMs,
  },
  {
    tieBreaker: accessLogs.id,
    defaultOrder: [desc(accessLogs.createdAt), desc(accessLogs.id)],
  },
);
