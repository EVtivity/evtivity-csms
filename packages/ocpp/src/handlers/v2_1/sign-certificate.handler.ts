// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isPncEnabled } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import { getPkiProvider } from '../../services/pki/index.js';
import { isValidCsr, markCsrFailed, recordCsrRequest } from '../../services/pki/csr-requests.js';

/**
 * SignCertificate (OCPP 2.1 A02, A03; the 1.6 Security Whitepaper message has
 * only `csr`, so the type defaults to ChargingStationCertificate). Every CSR
 * the CSMS accepts is recorded in pki_csr_requests with its requestId, then
 * handed to the PKI provider. A CSR that does not parse or verify is Rejected
 * (A02.FR.12): no provider can sign it.
 */
export async function handleSignCertificate(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    csr: string;
    certificateType?: string;
    requestId?: number;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, certificateType: request.certificateType },
    'SignCertificate received',
  );

  const certificateType = request.certificateType ?? 'ChargingStationCertificate';
  const requestId = request.requestId ?? null;

  // V2G certificates require PnC to be enabled; ChargingStationCertificate is for SP3/mTLS
  if (certificateType !== 'ChargingStationCertificate' && !(await isPncEnabled())) {
    ctx.logger.warn({ stationId: ctx.stationId }, 'SignCertificate rejected: PnC disabled');
    return { status: 'Rejected' };
  }

  if (!(await isValidCsr(request.csr))) {
    ctx.logger.warn(
      { stationId: ctx.stationId, certificateType },
      'SignCertificate rejected: the CSR is not a valid PKCS#10 request',
    );
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
      requestId,
    },
  });

  const csrId = await recordCsrRequest({
    stationDbId: ctx.stationDbId,
    csr: request.csr,
    certificateType,
    requestId,
  });

  // Attempt sync signing via provider. Only dispatch CertificateSigned when
  // the provider actually returns a signed chain.
  //
  // - Hubject (or other auto-signing provider) success: pnc.CsrSigned marks
  //   this CSR signed and dispatches CertificateSigned with its requestId.
  // - Manual and local providers: throw MANUAL_SIGNING_REQUIRED. The CSR stays
  //   pending until the operator signs it (POST /v1/pnc/csr-requests/:id/sign),
  //   which dispatches the real CertificateSigned command.
  // - Other provider errors: the CSR ends rejected with the reason. No
  //   placeholder certificate goes out; the station resends SignCertificate
  //   when no CertificateSigned arrives (A02.FR.17).
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
        csrId,
        requestId,
        certificateChain: result.certificateChain,
        certificateType,
        providerReference: result.providerReference,
      },
    });
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === 'MANUAL_SIGNING_REQUIRED') {
      ctx.logger.info(
        { stationId: ctx.stationId, certificateType, csrId },
        'CSR queued for manual signing; operator will dispatch CertificateSigned',
      );
    } else {
      ctx.logger.error(
        { err, stationId: ctx.stationId, certificateType, csrId },
        'CSR signing failed; station will retry SignCertificate',
      );
      try {
        await markCsrFailed(csrId, error.message);
      } catch (markErr) {
        // Recoverable (P9): the station still gets its answer and retries.
        ctx.logger.warn({ err: markErr, csrId }, 'Could not mark the failed CSR rejected');
      }
    }
  }

  return { status: 'Accepted' };
}
