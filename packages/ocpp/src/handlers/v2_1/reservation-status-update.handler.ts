// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleReservationStatusUpdate(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    reservationId: number;
    reservationUpdateStatus: string;
  };

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      reservationId: request.reservationId,
      status: request.reservationUpdateStatus,
    },
    'ReservationStatusUpdate received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.ReservationStatusUpdate',
    aggregateType: 'Reservation',
    aggregateId: ctx.stationId,
    payload: {
      reservationId: request.reservationId,
      reservationUpdateStatus: request.reservationUpdateStatus,
    },
  });

  return {};
}
