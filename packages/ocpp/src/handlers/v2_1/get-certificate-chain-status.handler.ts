// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import {
  getCertificateChainStatus,
  type CertificateStatusRequestInfo,
} from '../../services/pki/certificate-chain-status.js';

/**
 * GetCertificateChainStatus (OCPP 2.1 M07): the revocation status of each
 * vehicle certificate, by OCSP or CRL as the station asks (M07.FR.01 to
 * FR.07), one entry per request (M07.FR.08). Not gated by pnc.enabled, like
 * GetCertificateStatus: the request carries no certificate type.
 */
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
      stationId: ctx.stationId,
      stationDbId: ctx.stationDbId,
      certificateStatusRequests: requests,
    },
  });

  // The station names the OCSP responders and CRL locations, so their
  // failures carry it.
  const certificateStatus = await getCertificateChainStatus(
    requests,
    ctx.logger.child({ stationId: ctx.stationId }),
  );
  return { certificateStatus };
}
