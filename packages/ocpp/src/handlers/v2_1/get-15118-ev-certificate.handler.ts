// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isPncEnabled } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import { getPkiProvider } from '../../services/pki/index.js';

export async function handleGet15118EVCertificate(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    iso15118SchemaVersion: string;
    action: string;
    exiRequest: string;
  };

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      action: request.action,
      iso15118SchemaVersion: request.iso15118SchemaVersion,
    },
    'Get15118EVCertificate received',
  );

  if (!(await isPncEnabled())) {
    ctx.logger.warn({ stationId: ctx.stationId }, 'Get15118EVCertificate rejected: PnC disabled');
    return { status: 'Failed', exiResponse: '' };
  }

  await ctx.eventBus.publish({
    eventType: 'ocpp.Get15118EVCertificate',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      iso15118SchemaVersion: request.iso15118SchemaVersion,
      action: request.action,
      exiRequest: request.exiRequest,
    },
  });

  try {
    const provider = await getPkiProvider();
    const result = await provider.getContractCertificate(request.exiRequest);
    if (result.status === 'Accepted' && result.exiResponse !== '') {
      return { status: result.status, exiResponse: result.exiResponse };
    }
    ctx.logger.warn(
      { stationId: ctx.stationId, providerStatus: result.status },
      'Get15118EVCertificate: provider returned no usable response',
    );
  } catch (err) {
    ctx.logger.error({ err, stationId: ctx.stationId }, 'Contract certificate retrieval failed');
  }

  // No provider could fulfill the request. Per OCPP 2.1 Part 2 M01 the CSMS
  // returns Failed with an empty exiResponse so the EV's ISO 15118 stack
  // aborts the contract authentication cleanly instead of trying to verify a
  // fabricated EXI payload.
  return { status: 'Failed', exiResponse: '' };
}
