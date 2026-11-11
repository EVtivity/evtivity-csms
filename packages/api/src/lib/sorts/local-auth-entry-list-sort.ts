// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { drivers, stationLocalAuthEntries } from '@evtivity/database';
import { defineListSort, sortablePersonName } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/stations/:stationId/local-auth-list` (`api/routes.md`,
 * "List sorting"): FROM `station_local_auth_entries` with the token's driver joined.
 */
export const localAuthEntryListSort = defineListSort(
  {
    idToken: stationLocalAuthEntries.idToken,
    tokenType: stationLocalAuthEntries.tokenType,
    driver: sortablePersonName(drivers.firstName, drivers.lastName),
    authStatus: stationLocalAuthEntries.authStatus,
    addedAt: stationLocalAuthEntries.addedAt,
  },
  {
    tieBreaker: stationLocalAuthEntries.id,
    defaultOrder: [desc(stationLocalAuthEntries.addedAt), desc(stationLocalAuthEntries.id)],
  },
);
