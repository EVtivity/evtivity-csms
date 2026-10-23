// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readStationDataPlans } from '@evtivity/database';
import { DEFAULT_DATA_PLAN, createLogger } from '@evtivity/lib';
import type { DataPlan } from '@evtivity/lib';
import type { SessionState } from './session-state.js';

const logger = createLogger('session-data-plan');

/**
 * Reads the effective data plan of the session's station (resolveDataPlan:
 * station choice, confirmed SIM, site plan, default) into `session.dataPlan`
 * and returns it. A station without a database id runs the default plan. A
 * failed read keeps the session's current plan (fail-open: the next boot or
 * plan change reads it again).
 */
export async function refreshSessionDataPlan(session: SessionState): Promise<DataPlan> {
  const id = session.stationDbId;
  if (id == null) {
    session.dataPlan = DEFAULT_DATA_PLAN;
    return session.dataPlan;
  }
  try {
    const state = (await readStationDataPlans([id])).get(id);
    session.dataPlan = state?.plan ?? DEFAULT_DATA_PLAN;
  } catch (err) {
    logger.warn(
      { err, stationId: session.stationId },
      'Station data plan read failed, keeping the current plan',
    );
  }
  return session.dataPlan;
}
