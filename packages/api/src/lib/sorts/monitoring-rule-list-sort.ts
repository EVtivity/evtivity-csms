// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { variableMonitoringRules } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/stations/:id/monitoring-rules` (`api/routes.md`, "List
 * sorting"). The keys differ from the EV charging schedules list, which shares its tab and
 * the URL sort.
 */
export const monitoringRuleListSort = defineListSort(
  {
    component: variableMonitoringRules.component,
    variable: variableMonitoringRules.variable,
    type: variableMonitoringRules.type,
    value: variableMonitoringRules.value,
    severity: variableMonitoringRules.severity,
    monitoringId: variableMonitoringRules.monitoringId,
    status: variableMonitoringRules.status,
    createdAt: variableMonitoringRules.createdAt,
  },
  {
    tieBreaker: variableMonitoringRules.id,
    defaultOrder: [desc(variableMonitoringRules.createdAt), desc(variableMonitoringRules.id)],
  },
);
