// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { asc, desc, sql } from 'drizzle-orm';
import {
  chargingStations,
  configTemplatePushStations,
  configTemplatePushes,
  configTemplates,
} from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/config-templates` (`api/routes.md`, "List sorting"). */
export const configTemplateListSort = defineListSort(
  {
    name: configTemplates.name,
    description: configTemplates.description,
    // As the list counts them: the array length, 0 for anything that is not an array.
    variableCount: sql`case when jsonb_typeof(${configTemplates.variables}) = 'array' then jsonb_array_length(${configTemplates.variables}) else 0 end`,
    createdAt: configTemplates.createdAt,
  },
  {
    tieBreaker: configTemplates.id,
    defaultOrder: [desc(configTemplates.createdAt), desc(configTemplates.id)],
  },
);

/** The sortable columns of `GET /v1/config-templates/:id/pushes`. */
export const configTemplatePushListSort = defineListSort(
  {
    createdAt: configTemplatePushes.createdAt,
    status: configTemplatePushes.status,
  },
  {
    tieBreaker: configTemplatePushes.id,
    defaultOrder: [desc(configTemplatePushes.createdAt), desc(configTemplatePushes.id)],
  },
);

/** The sortable columns of the station results of `GET /v1/config-template-pushes/:pushId`. */
export const configTemplatePushStationListSort = defineListSort(
  {
    station: chargingStations.stationId,
    status: configTemplatePushStations.status,
    updatedAt: configTemplatePushStations.updatedAt,
  },
  {
    tieBreaker: configTemplatePushStations.id,
    defaultOrder: [asc(chargingStations.stationId)],
  },
);
