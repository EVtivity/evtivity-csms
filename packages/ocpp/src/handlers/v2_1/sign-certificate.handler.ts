// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isPncEnabled } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import { getPkiProvider } from '../../services/pki/index.js';

export async function handleSignCertificate(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    csr: string;
    certificateType?: string;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, certificateType: request.certificateType },
    'SignCertificate received',
  );

  const certificateType = request.certificateType ?? 'ChargingStationCertificate';

  // V2G certificates require PnC to be enabled; ChargingStationCertificate is for SP3/mTLS
  if (certificateType !== 'ChargingStationCertificate' && !(await isPncEnabled())) {
    ctx.logger.warn({ stationId: ctx.stationId }, 'SignCertificate rejected: PnC disabled');
    return { status: 'Rejected' };
  }

  await ctx.eventBus.publish({
    eventType: 'ocpp.SignCertificate',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      stationDbId: ctx.stationDbId,
      csr: request.csr,
      certificateType: request.certificateType,
    },
  });

  // Attempt sync signing via provider. Only dispatch CertificateSigned when
  // the provider actually returns a signed chain.
  //
  // - Hubject (or other auto-signing provider) success: dispatch immediately.
  // - Manual provider: throws MANUAL_SIGNING_REQUIRED after queueing the CSR.
  //   The operator later POSTs /v1/pnc/csr-requests/:id/sign which dispatches
  //   the real CertificateSigned command. Dispatching anything here would
  //   race with the operator's signed cert.
  // - Other provider errors: log; do NOT dispatch a bogus placeholder. The
  //   prior placeholder PEM was not a valid X.509 cert, so stations rejected
  //   it anyway, and the fallback payload was missing stationId/stationDbId
  //   so the OCPP command projection couldn't route it. Stations re-issue
  //   SignCertificate on retry, so silent failure here is safer than fanning
  //   out an invalid cert.
  try {
    const provider = await getPkiProvider();
    const result = await provider.signCsr(request.csr, certificateType);

    await ctx.eventBus.publish({
      eventType: 'pnc.CsrSigned',
      aggregateType: 'ChargingStation',
      aggregateId: ctx.stationId,
      payload: {
        stationId: ctx.stationId,
        stationDbId: ctx.stationDbId,
        certificateChain: result.certificateChain,
        certificateType,
        providerReference: result.providerReference,
      },
    });
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === 'MANUAL_SIGNING_REQUIRED') {
      ctx.logger.info(
        { stationId: ctx.stationId, certificateType },
        'CSR queued for manual signing; operator will dispatch CertificateSigned',
      );
    } else {
      ctx.logger.error(
        { err, stationId: ctx.stationId, certificateType },
        'CSR signing failed; station will retry SignCertificate',
      );
    }
  }

  return { status: 'Accepted' };
}
