// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { authorizeAttempts } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/authorize-attempts` (`api/routes.md`, "List sorting"). */
export const authorizeAttemptListSort = defineListSort(
  {
    createdAt: authorizeAttempts.createdAt,
    // The OCPP id the station presented, as the column shows it.
    station: authorizeAttempts.stationId,
    idToken: authorizeAttempts.idToken,
    tokenType: authorizeAttempts.tokenType,
    vehicleIdValue: authorizeAttempts.vehicleIdValue,
    outcome: authorizeAttempts.outcome,
    reason: authorizeAttempts.reason,
  },
  {
    tieBreaker: authorizeAttempts.id,
    defaultOrder: [desc(authorizeAttempts.createdAt), desc(authorizeAttempts.id)],
  },
);
