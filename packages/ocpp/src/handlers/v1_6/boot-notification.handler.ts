// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { getHeartbeatIntervalSeconds } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { BootNotification } from '../../generated/v1_6/types/messages/BootNotification.js';
import { resolveBootStatus } from '../boot-status.js';

export async function handleBootNotification(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as BootNotification;

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      vendor: request.chargePointVendor,
      model: request.chargePointModel,
      firmware: request.firmwareVersion,
    },
    'BootNotification received (1.6)',
  );

  // Settled first: under open registration it accepts a pending station, and
  // the projection of the event below reads that onboarding status.
  const status = await resolveBootStatus(ctx, '1.6');

  await ctx.eventBus.publish({
    eventType: 'ocpp.BootNotification',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      vendorName: request.chargePointVendor,
      model: request.chargePointModel,
      serialNumber: request.chargePointSerialNumber,
      firmwareVersion: request.firmwareVersion,
      iccid: request.iccid,
      imsi: request.imsi,
    },
  });

  ctx.session.bootStatus = status;
  return {
    status,
    currentTime: new Date().toISOString(),
    interval: await getHeartbeatIntervalSeconds(),
  };
}
