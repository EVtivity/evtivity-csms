// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';

const isPncEnabledMock = vi.fn().mockResolvedValue(true);
const getContractCertificateMock = vi.fn();

vi.mock('@evtivity/database', () => ({
  isPncEnabled: isPncEnabledMock,
}));

vi.mock('../../../services/pki/index.js', () => ({
  getPkiProvider: vi.fn(async () => ({
    signCsr: vi.fn(),
    getContractCertificate: getContractCertificateMock,
    getOcspStatus: vi.fn(),
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
    },
    messageId: 'msg-1',
    action: 'Get15118EVCertificate',
    protocolVersion: 'ocpp2.1',
    payload,
    logger,
    eventBus: { publish: publishMock, subscribe: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
  return { ctx, publishMock };
}

const reqPayload = {
  iso15118SchemaVersion: 'urn:iso:15118:2:2013:MsgDef',
  action: 'Install',
  exiRequest: 'exi-blob',
};

beforeEach(() => {
  vi.clearAllMocks();
  isPncEnabledMock.mockResolvedValue(true);
  getContractCertificateMock.mockResolvedValue({ status: 'Accepted', exiResponse: 'exi-resp' });
});

describe('v2_1 Get15118EVCertificate handler', () => {
  it('rejects with Failed when PnC is disabled and publishes nothing', async () => {
    isPncEnabledMock.mockResolvedValue(false);
    const { handleGet15118EVCertificate } =
      await import('../../../handlers/v2_1/get-15118-ev-certificate.handler.js');
    const { ctx, publishMock } = makeCtx(reqPayload);
    const response = await handleGet15118EVCertificate(ctx);

    expect(response).toEqual({ status: 'Failed', exiResponse: '' });
    expect(publishMock).not.toHaveBeenCalled();
    expect(getContractCertificateMock).not.toHaveBeenCalled();
  });

  it('publishes ocpp.Get15118EVCertificate and returns provider exiResponse on Accepted', async () => {
    const { handleGet15118EVCertificate } =
      await import('../../../handlers/v2_1/get-15118-ev-certificate.handler.js');
    const { ctx, publishMock } = makeCtx(reqPayload);
    const response = await handleGet15118EVCertificate(ctx);

    expect(response).toEqual({ status: 'Accepted', exiResponse: 'exi-resp' });
    expect(getContractCertificateMock).toHaveBeenCalledWith('exi-blob');
    expect(publishMock).toHaveBeenCalledWith({
      eventType: 'ocpp.Get15118EVCertificate',
      aggregateType: 'ChargingStation',
      aggregateId: 'CS-001',
      payload: {
        stationId: 'CS-001',
        stationDbId: 'sta_db_1',
        iso15118SchemaVersion: reqPayload.iso15118SchemaVersion,
        action: 'Install',
        exiRequest: 'exi-blob',
      },
    });
  });

  it('returns Failed when the provider responds Accepted but with an empty exiResponse', async () => {
    getContractCertificateMock.mockResolvedValue({ status: 'Accepted', exiResponse: '' });
    const { handleGet15118EVCertificate } =
      await import('../../../handlers/v2_1/get-15118-ev-certificate.handler.js');
    const { ctx } = makeCtx(reqPayload);
    const response = await handleGet15118EVCertificate(ctx);

    expect(response).toEqual({ status: 'Failed', exiResponse: '' });
  });

  it('returns Failed when the provider responds with non-Accepted status', async () => {
    getContractCertificateMock.mockResolvedValue({ status: 'Failed', exiResponse: '' });
    const { handleGet15118EVCertificate } =
      await import('../../../handlers/v2_1/get-15118-ev-certificate.handler.js');
    const { ctx } = makeCtx(reqPayload);
    const response = await handleGet15118EVCertificate(ctx);

    expect(response).toEqual({ status: 'Failed', exiResponse: '' });
  });

  it('returns Failed when the provider throws', async () => {
    getContractCertificateMock.mockRejectedValue(new Error('provider error'));
    const { handleGet15118EVCertificate } =
      await import('../../../handlers/v2_1/get-15118-ev-certificate.handler.js');
    const { ctx, publishMock } = makeCtx(reqPayload);
    const response = await handleGet15118EVCertificate(ctx);

    expect(response).toEqual({ status: 'Failed', exiResponse: '' });
    // event still published before the provider call failed
    expect(publishMock).toHaveBeenCalledTimes(1);
  });
});
