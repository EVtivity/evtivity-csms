// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { reports } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/reports` (`api/routes.md`, "List sorting"). */
export const reportListSort = defineListSort(
  {
    name: reports.name,
    reportType: reports.reportType,
    format: reports.format,
    status: reports.status,
    fileSize: reports.fileSize,
    createdAt: reports.createdAt,
  },
  {
    tieBreaker: reports.id,
    defaultOrder: [desc(reports.createdAt), desc(reports.id)],
  },
);
