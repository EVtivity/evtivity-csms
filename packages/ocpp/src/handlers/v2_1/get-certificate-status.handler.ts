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
    ctx.logger.warn(
      { stationId: ctx.stationId, providerStatus: result.status },
      'GetCertificateStatus: provider returned non-Accepted status',
    );
  } catch (err) {
    ctx.logger.warn(
      {
        stationId: ctx.stationId,
        responderURL: request.ocspRequestData.responderURL,
        err: err instanceof Error ? err.message : String(err),
      },
      'OCSP status check failed',
    );
  }

  // The OCSP responder was unreachable or rejected the request. Per OCPP 2.1
  // Part 2 M03 the CSMS returns Failed so the station does not treat an
  // unverified certificate as live. Returning a fabricated ocspResult here
  // would let a revoked certificate pass the EV's signature check.
  return { status: 'Failed', ocspResult: '' };
}
