// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { ocpiCdrs, ocpiPartners } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/ocpi/cdrs` (`api/routes.md`, "List sorting"). */
export const ocpiCdrListSort = defineListSort(
  {
    partner: ocpiPartners.name,
    ocpiCdrId: ocpiCdrs.ocpiCdrId,
    totalEnergy: ocpiCdrs.totalEnergy,
    totalCost: ocpiCdrs.totalCost,
    // Charge (false) before credit (true) ascending.
    type: ocpiCdrs.isCredit,
    pushStatus: ocpiCdrs.pushStatus,
    createdAt: ocpiCdrs.createdAt,
  },
  {
    tieBreaker: ocpiCdrs.id,
    defaultOrder: [desc(ocpiCdrs.createdAt), desc(ocpiCdrs.id)],
  },
);
