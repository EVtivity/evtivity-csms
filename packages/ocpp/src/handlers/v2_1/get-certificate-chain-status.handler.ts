// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

interface CertificateStatusRequestInfo {
  source: string;
  urls: string[];
  certificateHashData: {
    hashAlgorithm: string;
    issuerNameHash: string;
    issuerKeyHash: string;
    serialNumber: string;
  };
}

export async function handleGetCertificateChainStatus(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    certificateStatusRequests?: CertificateStatusRequestInfo[];
  };

  const requests = request.certificateStatusRequests ?? [];

  ctx.logger.info(
    { stationId: ctx.stationId, certificateCount: requests.length },
    'GetCertificateChainStatus received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.GetCertificateChainStatus',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      certificateStatusRequests: requests,
    },
  });

  // Response schema requires certificateStatus array.
  // Return one status entry per request with status Unknown and a near-future nextUpdate.
  const nextUpdate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const certificateStatus = requests.map((req) => ({
    source: req.source,
    status: 'Unknown' as const,
    nextUpdate,
    certificateHashData: req.certificateHashData,
  }));

  return { certificateStatus };
}
