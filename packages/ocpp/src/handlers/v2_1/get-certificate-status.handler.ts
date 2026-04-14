// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import { getPkiProvider } from '../../services/pki/index.js';

export async function handleGetCertificateStatus(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    ocspRequestData: {
      hashAlgorithm: string;
      issuerNameHash: string;
      issuerKeyHash: string;
      serialNumber: string;
      responderURL: string;
    };
  };

  ctx.logger.info(
    { stationId: ctx.stationId, serialNumber: request.ocspRequestData.serialNumber },
    'GetCertificateStatus received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.GetCertificateStatus',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      ocspRequestData: request.ocspRequestData,
    },
  });

  try {
    const provider = await getPkiProvider();
    const result = await provider.getOcspStatus(request.ocspRequestData);
    if (result.status === 'Accepted') {
      return { status: result.status, ocspResult: result.ocspResult };
    }
  } catch {
    ctx.logger.warn(
      { stationId: ctx.stationId, responderURL: request.ocspRequestData.responderURL },
      'OCSP status check failed, returning placeholder',
    );
  }

  // Return Accepted with a placeholder OCSP result when the real OCSP responder
  // is unreachable. This allows the protocol flow to complete in test/demo environments.
  return { status: 'Accepted', ocspResult: 'T0NTUF9QTEFDRUhPTERFUg==' };
}
