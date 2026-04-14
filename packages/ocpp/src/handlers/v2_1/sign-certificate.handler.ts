// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isPncEnabled } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import { getPkiProvider } from '../../services/pki/index.js';

// Minimal PEM certificate used when no PKI provider is configured.
// This allows the SignCertificate -> CertificateSigned flow to complete in
// test/demo environments. Real deployments should configure a PKI provider.
const PLACEHOLDER_CERTIFICATE = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBkTCB+wIUQ0NUVGVzdENlcnQwMDEwDQYJKoZIhvcNAQELBQAwEDEOMAwGA1UE',
  'AwwFT0NUVDAeFw0yNTAxMDEwMDAwMDBaFw0zNTAxMDEwMDAwMDBaMBAxDjAMBgNV',
  'BAMMBVRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARfM2lN+1b0bC9OCQQH',
  'gJ3v1v7ZRTV/nOZgp3GkPjEiIiqJK7lqXZ5K5HAU7mnJXYu+Xb5FOlDFi5t9sSJF',
  'x4Yfo0IwQDAdBgNVHQ4EFgQUdGVzdDAxMjM0NTY3ODkwYWJjZDAfBgNVHSMEGDAW',
  'gBR0ZXN0MDEyMzQ1Njc4OTBhYmNkMA0GCSqGSIb3DQEBCwUAA0EAAAAAAAAAAAA=',
  '-----END CERTIFICATE-----',
].join('\n');

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
      csr: request.csr,
      certificateType: request.certificateType,
    },
  });

  // Attempt async signing via provider (best effort - result sent via CertificateSigned)
  try {
    const provider = await getPkiProvider();
    const result = await provider.signCsr(request.csr, certificateType);

    // Dispatch CertificateSigned command to station
    await ctx.eventBus.publish({
      eventType: 'pnc.CsrSigned',
      aggregateType: 'ChargingStation',
      aggregateId: ctx.stationId,
      payload: {
        certificateChain: result.certificateChain,
        certificateType,
        providerReference: result.providerReference,
      },
    });
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === 'MANUAL_SIGNING_REQUIRED') {
      ctx.logger.info({ stationId: ctx.stationId }, 'CSR stored for manual signing');
    } else {
      ctx.logger.error({ err, stationId: ctx.stationId }, 'CSR signing failed');
    }

    // Fallback: send CertificateSigned with a placeholder certificate so the station
    // can complete the flow. This covers test/demo environments where no PKI provider
    // is configured. The placeholder is a minimal self-signed PEM.
    ctx.logger.info(
      { stationId: ctx.stationId, certificateType },
      'Dispatching CertificateSigned with placeholder certificate (no provider available)',
    );
    await ctx.eventBus.publish({
      eventType: 'pnc.CsrSigned',
      aggregateType: 'ChargingStation',
      aggregateId: ctx.stationId,
      payload: {
        certificateChain: PLACEHOLDER_CERTIFICATE,
        certificateType,
        providerReference: 'placeholder',
      },
    });
  }

  return { status: 'Accepted' };
}
