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
      stationDbId: ctx.stationDbId,
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
    } catch (err: unknown) {
      // DB unreachable: fail closed. Returning Accepted here would let a
      // blocked station slip through during a transient outage. Per OCPP 2.1
      // B02.FR.04 the station retries after `interval` seconds on Pending,
      // which is the right recovery once the DB is back.
      ctx.logger.warn(
        { stationId: ctx.stationId, err: err instanceof Error ? err.message : String(err) },
        'BootNotification: onboarding lookup failed, returning Pending to force station retry',
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

  const response: BootNotificationResponse = {
    currentTime,
    interval,
    status: 'Accepted',
  };

  ctx.session.bootStatus = 'Accepted';
  return response as unknown as Record<string, unknown>;
}
