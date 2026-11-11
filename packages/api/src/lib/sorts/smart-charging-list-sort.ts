// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { asc, desc } from 'drizzle-orm';
import {
  chargingProfilePushStations,
  chargingProfilePushes,
  chargingProfileTemplates,
  chargingStations,
} from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/smart-charging/templates` (`api/routes.md`, "List sorting"). */
export const chargingProfileTemplateListSort = defineListSort(
  {
    name: chargingProfileTemplates.name,
    description: chargingProfileTemplates.description,
    profilePurpose: chargingProfileTemplates.profilePurpose,
    profileKind: chargingProfileTemplates.profileKind,
    chargingRateUnit: chargingProfileTemplates.chargingRateUnit,
    ocppVersion: chargingProfileTemplates.ocppVersion,
    createdAt: chargingProfileTemplates.createdAt,
  },
  {
    tieBreaker: chargingProfileTemplates.id,
    defaultOrder: [desc(chargingProfileTemplates.createdAt), desc(chargingProfileTemplates.id)],
  },
);

/** The sortable columns of `GET /v1/smart-charging/templates/:id/pushes`. */
export const chargingProfilePushListSort = defineListSort(
  {
    createdAt: chargingProfilePushes.createdAt,
    operation: chargingProfilePushes.operation,
    status: chargingProfilePushes.status,
  },
  {
    tieBreaker: chargingProfilePushes.id,
    defaultOrder: [desc(chargingProfilePushes.createdAt), desc(chargingProfilePushes.id)],
  },
);

/** The sortable columns of the station results of `GET /v1/smart-charging/pushes/:pushId`. */
export const chargingProfilePushStationListSort = defineListSort(
  {
    station: chargingStations.stationId,
    status: chargingProfilePushStations.status,
    updatedAt: chargingProfilePushStations.updatedAt,
  },
  {
    tieBreaker: chargingProfilePushStations.id,
    defaultOrder: [asc(chargingStations.stationId)],
  },
);
