// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import { maskStationCredentials } from '@evtivity/lib/secret-config';

export async function handleNotifyReport(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    requestId: number;
    generatedAt: string;
    seqNo: number;
    tbc?: boolean;
    reportData?: unknown[];
  };

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      requestId: request.requestId,
      seqNo: request.seqNo,
      reportCount: request.reportData?.length ?? 0,
    },
    'NotifyReport received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyReport',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      stationDbId: ctx.stationDbId,
      requestId: request.requestId,
      generatedAt: request.generatedAt,
      seqNo: request.seqNo,
      tbc: request.tbc,
      // A station credential never leaves this handler (station_configurations, domain_events).
      reportData: maskStationCredentials(request.reportData),
    },
  });

  // A reported SmartChargingCtrlr.MaxExternalConstraintsId is only recorded
  // (the NotifyReport projection stores it in station_configurations). The
  // CSMS never sends a ChargingStationExternalConstraints profile (K01.FR.22);
  // K01.FR.80 asks only that its own profile ids stay above that value.

  return {};
}
