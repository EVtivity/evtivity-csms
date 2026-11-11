// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { ocpiPartners, ocpiRoamingSessions } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/ocpi/sessions` (`api/routes.md`, "List sorting"). */
export const ocpiSessionListSort = defineListSort(
  {
    partner: ocpiPartners.name,
    tokenUid: ocpiRoamingSessions.tokenUid,
    status: ocpiRoamingSessions.status,
    kwh: ocpiRoamingSessions.kwh,
    totalCost: ocpiRoamingSessions.totalCost,
    createdAt: ocpiRoamingSessions.createdAt,
  },
  {
    tieBreaker: ocpiRoamingSessions.id,
    defaultOrder: [desc(ocpiRoamingSessions.createdAt), desc(ocpiRoamingSessions.id)],
  },
);
