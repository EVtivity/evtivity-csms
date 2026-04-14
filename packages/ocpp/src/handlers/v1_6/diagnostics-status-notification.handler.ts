// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { DiagnosticsStatusNotification } from '../../generated/v1_6/types/messages/DiagnosticsStatusNotification.js';

export async function handleDiagnosticsStatusNotification(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as DiagnosticsStatusNotification;

  ctx.logger.info(
    { stationId: ctx.stationId, status: request.status },
    'DiagnosticsStatusNotification received (1.6)',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.DiagnosticsStatus',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      status: request.status,
    },
  });

  return {};
}
