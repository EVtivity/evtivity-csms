// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import {
  db,
  chargingStations,
  getHeartbeatIntervalSeconds,
  getRegistrationPolicy,
} from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { BootNotificationRequest } from '../../generated/v2_1/types/messages/BootNotificationRequest.js';
import type { BootNotificationResponse } from '../../generated/v2_1/types/messages/BootNotificationResponse.js';

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

  await ctx.eventBus.publish({
    eventType: 'ocpp.BootNotification',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      vendorName: request.chargingStation.vendorName,
      model: request.chargingStation.model,
      serialNumber: request.chargingStation.serialNumber,
      firmwareVersion: request.chargingStation.firmwareVersion,
      iccid: request.chargingStation.modem?.iccid,
      imsi: request.chargingStation.modem?.imsi,
    },
  });

  const currentTime = new Date().toISOString();
  const interval = await getHeartbeatIntervalSeconds();

  if (ctx.stationDbId != null) {
    try {
      const [station] = await db
        .select({ onboardingStatus: chargingStations.onboardingStatus })
        .from(chargingStations)
        .where(eq(chargingStations.id, ctx.stationDbId));

      if (station?.onboardingStatus === 'blocked') {
        ctx.logger.info(
          { stationId: ctx.stationId },
          'BootNotification rejected: station is blocked',
        );
        const rejected: BootNotificationResponse = {
          currentTime,
          interval,
          status: 'Rejected',
        };
        ctx.session.bootStatus = 'Rejected';
        return rejected as unknown as Record<string, unknown>;
      }

      if (station?.onboardingStatus === 'pending') {
        const policy = await getRegistrationPolicy();
        if (policy === 'approval-required') {
          ctx.logger.info(
            { stationId: ctx.stationId },
            'BootNotification pending: station awaiting approval',
          );
          const pending: BootNotificationResponse = {
            currentTime,
            interval,
            status: 'Pending',
          };
          ctx.session.bootStatus = 'Pending';
          return pending as unknown as Record<string, unknown>;
        }
      }
    } catch {
      // DB error: fall through to Accepted
    }
  }

  const response: BootNotificationResponse = {
    currentTime,
    interval,
    status: 'Accepted',
  };

  ctx.session.bootStatus = 'Accepted';
  return response as unknown as Record<string, unknown>;
}
