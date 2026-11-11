// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { driverTokens, drivers } from '@evtivity/database';
import { defineListSort, sortablePersonName } from '../list-sort.js';

/** The sortable columns of `GET /v1/tokens` (`api/routes.md`, "List sorting"). */
export const tokenListSort = defineListSort(
  {
    idToken: driverTokens.idToken,
    label: driverTokens.label,
    driver: sortablePersonName(drivers.firstName, drivers.lastName),
    tokenType: driverTokens.tokenType,
    status: driverTokens.isActive,
    expiresAt: driverTokens.expiresAt,
    createdAt: driverTokens.createdAt,
  },
  {
    tieBreaker: driverTokens.id,
    defaultOrder: [desc(driverTokens.createdAt), desc(driverTokens.id)],
  },
);
