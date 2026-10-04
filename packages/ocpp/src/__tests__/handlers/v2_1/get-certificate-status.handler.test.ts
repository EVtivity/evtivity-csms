// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';

const getOcspStatusMock = vi.fn();

vi.mock('../../../services/pki/index.js', () => ({
  getPkiProvider: vi.fn(async () => ({
    signCsr: vi.fn(),
    getContractCertificate: vi.fn(),
    getOcspStatus: getOcspStatusMock,
    getRootCertificates: vi.fn(),
  })),
}));

const logger = pino({ level: 'silent' });

function makeCtx(payload: Record<string, unknown>): {
  ctx: HandlerContext;
  publishMock: ReturnType<typeof vi.fn>;
} {
  const publishMock = vi.fn().mockResolvedValue(undefined);
  const ctx: HandlerContext = {
    stationId: 'CS-001',
    stationDbId: 'sta_db_1',
    session: {
      stationId: 'CS-001',
      stationDbId: 'sta_db_1',
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
      readyAnnounced: false,
    },
    messageId: 'msg-1',
    action: 'GetCertificateStatus',
    protocolVersion: 'ocpp2.1',
    payload,
    logger,
    eventBus: { publish: publishMock, subscribe: vi.fn(), drain: vi.fn(), track: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
  return { ctx, publishMock };
}

const reqPayload = {
  ocspRequestData: {
    hashAlgorithm: 'SHA256',
    issuerNameHash: 'name-hash',
    issuerKeyHash: 'key-hash',
    serialNumber: 'SERIAL-1',
    responderURL: 'http://ocsp.example.com',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  getOcspStatusMock.mockResolvedValue({ status: 'Accepted', ocspResult: 'ocsp-blob' });
});

describe('v2_1 GetCertificateStatus handler', () => {
  it('publishes ocpp.GetCertificateStatus and returns the OCSP result on Accepted', async () => {
    const { handleGetCertificateStatus } =
      await import('../../../handlers/v2_1/get-certificate-status.handler.js');
    const { ctx, publishMock } = makeCtx(reqPayload);
    const response = await handleGetCertificateStatus(ctx);

    expect(response).toEqual({ status: 'Accepted', ocspResult: 'ocsp-blob' });
    expect(getOcspStatusMock).toHaveBeenCalledWith(reqPayload.ocspRequestData);
    expect(publishMock).toHaveBeenCalledWith({
      eventType: 'ocpp.GetCertificateStatus',
      aggregateType: 'ChargingStation',
      aggregateId: 'CS-001',
      payload: {
        stationId: 'CS-001',
        stationDbId: 'sta_db_1',
        ocspRequestData: reqPayload.ocspRequestData,
      },
    });
  });

  it('returns Failed when the provider responds with a non-Accepted status', async () => {
    getOcspStatusMock.mockResolvedValue({ status: 'Failed', ocspResult: '' });
    const { handleGetCertificateStatus } =
      await import('../../../handlers/v2_1/get-certificate-status.handler.js');
    const { ctx } = makeCtx(reqPayload);
    const response = await handleGetCertificateStatus(ctx);

    expect(response).toEqual({ status: 'Failed', ocspResult: '' });
  });

  it('returns Failed when the provider throws (OCSP responder unreachable)', async () => {
    getOcspStatusMock.mockRejectedValue(new Error('connection refused'));
    const { handleGetCertificateStatus } =
      await import('../../../handlers/v2_1/get-certificate-status.handler.js');
    const { ctx, publishMock } = makeCtx(reqPayload);
    const response = await handleGetCertificateStatus(ctx);

    expect(response).toEqual({ status: 'Failed', ocspResult: '' });
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('returns Failed when the provider throws a non-Error value', async () => {
    getOcspStatusMock.mockRejectedValue('string failure');
    const { handleGetCertificateStatus } =
      await import('../../../handlers/v2_1/get-certificate-status.handler.js');
    const { ctx } = makeCtx(reqPayload);
    const response = await handleGetCertificateStatus(ctx);

    expect(response).toEqual({ status: 'Failed', ocspResult: '' });
  });
});
