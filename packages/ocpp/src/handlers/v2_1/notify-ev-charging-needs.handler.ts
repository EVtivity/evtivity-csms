// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import { scheduledChargingTransaction } from '../../services/charging-needs.js';

export async function handleNotifyEVChargingNeeds(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    evseId: number;
    chargingNeeds: {
      requestedEnergyTransfer?: string;
      controlMode?: string;
      [key: string]: unknown;
    };
    maxScheduleTuples?: number;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, evseId: request.evseId },
    'NotifyEVChargingNeeds received',
  );

  // The projection sends the computed TxProfile for this transaction within
  // seconds (K15.FR.08), so the CSMS answers Accepted (K15.FR.03, K18.FR.03).
  // Without one it answers NoChargingProfile: the station then uses its
  // TxDefaultProfile (K18.FR.04, K19.FR.04). Never Rejected, which tells an
  // ISO 15118-20 station to stop the transaction (K18.FR.22, Q01.FR.06).
  const transactionId = await scheduledChargingTransaction(
    ctx.stationDbId,
    request.evseId,
    request.chargingNeeds,
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyEVChargingNeeds',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      stationDbId: ctx.stationDbId,
      evseId: request.evseId,
      chargingNeeds: request.chargingNeeds,
      maxScheduleTuples: request.maxScheduleTuples,
      transactionId,
    },
  });

  return { status: transactionId != null ? 'Accepted' : 'NoChargingProfile' };
}
