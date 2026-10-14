// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import { evScheduleWithinLimits, loadChargingNeedsProfile } from '../../services/charging-needs.js';

export async function handleNotifyEVChargingSchedule(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    timeBase: string;
    evseId: number;
    chargingSchedule: unknown;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, evseId: request.evseId, timeBase: request.timeBase },
    'NotifyEVChargingSchedule received',
  );

  // The CSMS checks the EV schedule against the TxProfile it sent for the
  // EVSE's charging needs: Accepted within its limits (K15.FR.11), else
  // Rejected and the projection starts a renegotiation (K15.FR.12/13). With no
  // CSMS profile there is nothing to exceed.
  const csms =
    ctx.stationDbId != null
      ? await loadChargingNeedsProfile(ctx.stationDbId, request.evseId)
      : null;
  const withinLimits =
    csms == null ||
    evScheduleWithinLimits(request.timeBase, request.chargingSchedule, csms.payload);

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyEVChargingSchedule',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      stationDbId: ctx.stationDbId,
      timeBase: request.timeBase,
      evseId: request.evseId,
      chargingSchedule: request.chargingSchedule,
      withinLimits,
    },
  });

  if (withinLimits) return { status: 'Accepted' };
  return {
    status: 'Rejected',
    statusInfo: {
      reasonCode: 'InvalidSchedule',
      additionalInfo: 'EV schedule exceeds the CSMS charging schedule',
    },
  };
}
