// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { chargingProfileTemplates, chargingProfiles } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/stations/:id/charging-profiles` (`api/routes.md`, "List
 * sorting"): FROM `charging_profiles` with the linked template joined (only templates the
 * caller may see, so a hidden template sorts as none).
 */
export const stationChargingProfileListSort = defineListSort(
  {
    source: chargingProfiles.source,
    evseId: chargingProfiles.evseId,
    chargingLimitSource: chargingProfiles.chargingLimitSource,
    template: chargingProfileTemplates.name,
    createdAt: chargingProfiles.createdAt,
  },
  {
    tieBreaker: chargingProfiles.id,
    defaultOrder: [desc(chargingProfiles.createdAt), desc(chargingProfiles.id)],
  },
);
