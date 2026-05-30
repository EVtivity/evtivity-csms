// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { StatusNotification } from '../../generated/v1_6/types/messages/StatusNotification.js';

export async function handleStatusNotification(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as StatusNotification;

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      connectorId: request.connectorId,
      status: request.status,
      ...(request.errorCode !== 'NoError' && { faultCode: request.errorCode }),
    },
    'StatusNotification received (1.6)',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.StatusNotification',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      stationDbId: ctx.stationDbId,
      evseId: request.connectorId,
      connectorId: request.connectorId,
      connectorStatus: request.status,
      timestamp: request.timestamp ?? new Date().toISOString(),
      // OCPP 1.6 fault diagnostics. The 1.6 StatusNotification carries
      // the error/vendor fields inline (unlike 2.1 which moved them to
      // NotifyEvent). Capturing them in the event keeps the data in
      // domain_events for operator triage even before a dedicated fault
      // projection consumes them.
      errorCode: request.errorCode,
      ...(request.info != null ? { info: request.info } : {}),
      ...(request.vendorId != null ? { vendorId: request.vendorId } : {}),
      ...(request.vendorErrorCode != null ? { vendorErrorCode: request.vendorErrorCode } : {}),
    },
  });

  return {};
}
