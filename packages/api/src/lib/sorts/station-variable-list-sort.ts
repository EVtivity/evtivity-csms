// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { stationConfigurations } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/stations/:id/variables` (`api/routes.md`, "List sorting"). */
export const stationVariableListSort = defineListSort(
  {
    component: stationConfigurations.component,
    variable: stationConfigurations.variable,
    value: stationConfigurations.value,
    attributeType: stationConfigurations.attributeType,
    source: stationConfigurations.source,
  },
  {
    tieBreaker: stationConfigurations.id,
    defaultOrder: [sql`${stationConfigurations.component}`, sql`${stationConfigurations.variable}`],
  },
);
