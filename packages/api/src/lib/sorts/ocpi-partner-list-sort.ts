// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc, sql } from 'drizzle-orm';
import { ocpiPartners } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/ocpi/partners` (`api/routes.md`, "List sorting"). */
export const ocpiPartnerListSort = defineListSort(
  {
    name: ocpiPartners.name,
    countryParty: sql`concat(${ocpiPartners.countryCode}, '*', ${ocpiPartners.partyId})`,
    status: ocpiPartners.status,
    version: ocpiPartners.version,
    createdAt: ocpiPartners.createdAt,
  },
  {
    tieBreaker: ocpiPartners.id,
    defaultOrder: [desc(ocpiPartners.createdAt), desc(ocpiPartners.id)],
  },
);
