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
import type { BootNotification } from '../../generated/v1_6/types/messages/BootNotification.js';

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
          'BootNotification rejected: station is blocked (1.6)',
        );
        ctx.session.bootStatus = 'Rejected';
        return { status: 'Rejected', currentTime, interval };
      }

      if (station?.onboardingStatus === 'pending') {
        const policy = await getRegistrationPolicy();
        if (policy === 'approval-required') {
          ctx.logger.info(
            { stationId: ctx.stationId },
            'BootNotification pending: station awaiting approval (1.6)',
          );
          ctx.session.bootStatus = 'Pending';
          return { status: 'Pending', currentTime, interval };
        }
      }
    } catch {
      // DB error: fall through to Accepted
    }
  }

  ctx.session.bootStatus = 'Accepted';
  return { status: 'Accepted', currentTime, interval };
}
