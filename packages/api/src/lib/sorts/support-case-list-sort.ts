// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc, sql } from 'drizzle-orm';
import { drivers, supportCases, users } from '@evtivity/database';
import { defineListSort, sortablePersonName } from '../list-sort.js';

/** The sortable columns of `GET /v1/support-cases` (`api/routes.md`, "List sorting"). */
export const supportCaseListSort = defineListSort(
  {
    caseNumber: supportCases.caseNumber,
    subject: supportCases.subject,
    driver: sortablePersonName(drivers.firstName, drivers.lastName),
    category: supportCases.category,
    // By urgency, not by the name of the level.
    priority: sql`case ${supportCases.priority} when 'low' then 1 when 'medium' then 2 when 'high' then 3 when 'urgent' then 4 end`,
    status: supportCases.status,
    assignedTo: sortablePersonName(users.firstName, users.lastName),
    createdAt: supportCases.createdAt,
  },
  {
    tieBreaker: supportCases.id,
    defaultOrder: [desc(supportCases.createdAt), desc(supportCases.id)],
  },
);
