// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

// Basic EU VAT number pattern: 2-letter country code followed by 2-13 alphanumeric characters
const VAT_NUMBER_PATTERN = /^[A-Z]{2}[0-9A-Z]{2,13}$/;

export async function handleVatNumberValidation(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    vatNumber: string;
    evseId?: number;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, vatNumber: request.vatNumber, evseId: request.evseId },
    'VatNumberValidation received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.VatNumberValidation',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      vatNumber: request.vatNumber,
      evseId: request.evseId,
    },
  });

  const isValid = request.vatNumber.length > 0 && VAT_NUMBER_PATTERN.test(request.vatNumber);

  const status = isValid ? 'Accepted' : 'Rejected';

  return { status, vatNumber: request.vatNumber };
}
