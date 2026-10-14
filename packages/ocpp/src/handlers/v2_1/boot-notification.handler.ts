// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { getHeartbeatIntervalSeconds } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { BootNotificationRequest } from '../../generated/v2_1/types/messages/BootNotificationRequest.js';
import type { BootNotificationResponse } from '../../generated/v2_1/types/messages/BootNotificationResponse.js';
import { resolveBootStatus } from '../boot-status.js';

export async function handleBootNotification(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as BootNotificationRequest;

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      vendor: request.chargingStation.vendorName,
      model: request.chargingStation.model,
      firmware: request.chargingStation.firmwareVersion,
    },
    'BootNotification received',
  );

  // Settled first: under open registration it accepts a pending station, and
  // the projection of the event below reads that onboarding status.
  const status = await resolveBootStatus(ctx, '2.1');

  await ctx.eventBus.publish({
    eventType: 'ocpp.BootNotification',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationDbId: ctx.stationDbId,
      vendorName: request.chargingStation.vendorName,
      model: request.chargingStation.model,
      serialNumber: request.chargingStation.serialNumber,
      firmwareVersion: request.chargingStation.firmwareVersion,
      iccid: request.chargingStation.modem?.iccid,
      imsi: request.chargingStation.modem?.imsi,
    },
  });

  const response: BootNotificationResponse = {
    currentTime: new Date().toISOString(),
    interval: await getHeartbeatIntervalSeconds(),
    status,
  };

  ctx.session.bootStatus = status;
  return response as unknown as Record<string, unknown>;
}
