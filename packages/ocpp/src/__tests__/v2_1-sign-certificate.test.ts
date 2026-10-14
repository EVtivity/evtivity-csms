// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../server/middleware/pipeline.js';
import { handleSignCertificate } from '../handlers/v2_1/sign-certificate.handler.js';
import { getPkiProvider } from '../services/pki/index.js';
import { isPncEnabled } from '@evtivity/database';

const mockSignCsr = vi.fn();

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isPncEnabled: vi.fn().mockResolvedValue(true),
  };
});

vi.mock('../services/pki/index.js', () => ({
  getPkiProvider: vi.fn().mockImplementation(async () => ({
    signCsr: mockSignCsr,
    getContractCertificate: vi.fn(),
    getOcspStatus: vi.fn(),
    getRootCertificates: vi.fn(),
  })),
}));

const { mockIsValidCsr, mockRecordCsr, mockMarkFailed } = vi.hoisted(() => ({
  mockIsValidCsr: vi.fn(),
  mockRecordCsr: vi.fn(),
  mockMarkFailed: vi.fn(),
}));

vi.mock('../services/pki/csr-requests.js', () => ({
  isValidCsr: mockIsValidCsr,
  recordCsrRequest: mockRecordCsr,
  markCsrFailed: mockMarkFailed,
}));

const logger = pino({ level: 'silent' });

function makeCtx(payload: Record<string, unknown>): {
  ctx: HandlerContext;
  publishMock: ReturnType<typeof vi.fn>;
} {
  const publishMock = vi.fn().mockResolvedValue(undefined);
  const ctx: HandlerContext = {
    stationId: 'CS-001',
    stationDbId: 'sta_001',
    session: {
      stationId: 'CS-001',
      stationDbId: null,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
      readyAnnounced: false,
    },
    messageId: 'msg-1',
    action: 'SignCertificate',
    protocolVersion: 'ocpp2.1',
    payload,
    logger,
    eventBus: {
      publish: publishMock,
      subscribe: vi.fn(),
      drain: vi.fn(),
      track: vi.fn(),
    },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
  return { ctx, publishMock };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockSignCsr.mockResolvedValue({
    certificateChain: 'mock-chain',
    providerReference: 'mock-ref',
  });
  vi.mocked(isPncEnabled).mockResolvedValue(true);
  mockIsValidCsr.mockResolvedValue(true);
  mockRecordCsr.mockResolvedValue(31);
  mockMarkFailed.mockResolvedValue(undefined);
  vi.mocked(getPkiProvider).mockResolvedValue({
    signCsr: mockSignCsr,
    getContractCertificate: vi.fn(),
    getOcspStatus: vi.fn(),
    getRootCertificates: vi.fn(),
  });
});

describe('v2_1 SignCertificate handler - uncovered branches', () => {
  it('defaults certificateType to ChargingStationCertificate when not provided', async () => {
    const { ctx, publishMock } = makeCtx({ csr: 'csr-data' });
    const response = await handleSignCertificate(ctx);

    expect(response).toEqual({ status: 'Accepted' });
    // The signCsr should be called with the default certificate type
    expect(mockSignCsr).toHaveBeenCalledWith('csr-data', 'ChargingStationCertificate');
    // Should publish both SignCertificate event and CsrSigned event
    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.SignCertificate' }),
    );
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'pnc.CsrSigned' }),
    );
  });

  it('publishes pnc.CsrSigned event with certificate chain after successful signing', async () => {
    mockSignCsr.mockResolvedValue({
      certificateChain: 'full-chain-pem',
      providerReference: 'ref-123',
    });

    const { ctx, publishMock } = makeCtx({
      csr: 'csr-data',
      certificateType: 'ChargingStationCertificate',
    });
    await handleSignCertificate(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'pnc.CsrSigned',
        aggregateType: 'ChargingStation',
        aggregateId: 'CS-001',
        payload: expect.objectContaining({
          certificateChain: 'full-chain-pem',
          certificateType: 'ChargingStationCertificate',
          providerReference: 'ref-123',
        }) as unknown,
      }),
    );
  });

  it('logs info and returns Accepted when provider throws MANUAL_SIGNING_REQUIRED', async () => {
    const manualError = new Error('Manual signing required');
    (manualError as Error & { code?: string }).code = 'MANUAL_SIGNING_REQUIRED';
    mockSignCsr.mockRejectedValue(manualError);

    const { ctx, publishMock } = makeCtx({
      csr: 'csr-data',
      certificateType: 'V2GCertificate',
    });
    const response = await handleSignCertificate(ctx);

    expect(response).toEqual({ status: 'Accepted' });
    // The SignCertificate event is published (async signing may publish additional events)
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.SignCertificate' }),
    );
  });

  it('records every accepted CSR with its station and requestId (A02.FR.25)', async () => {
    const { ctx, publishMock } = makeCtx({
      csr: 'csr-data',
      certificateType: 'V2GCertificate',
      requestId: 12,
    });
    await handleSignCertificate(ctx);
    expect(mockRecordCsr).toHaveBeenCalledWith({
      stationDbId: 'sta_001',
      csr: 'csr-data',
      certificateType: 'V2GCertificate',
      requestId: 12,
    });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'pnc.CsrSigned',
        payload: expect.objectContaining({ csrId: 31, requestId: 12 }) as unknown,
      }),
    );
  });

  it('rejects a CSR that is not a valid PKCS#10 request (A02.FR.12)', async () => {
    mockIsValidCsr.mockResolvedValue(false);
    const { ctx, publishMock } = makeCtx({ csr: 'garbage' });
    const response = await handleSignCertificate(ctx);
    expect(response).toEqual({ status: 'Rejected' });
    expect(mockRecordCsr).not.toHaveBeenCalled();
    expect(mockSignCsr).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('leaves a manual CSR pending (no failure mark)', async () => {
    const manualError = new Error('Manual signing required');
    (manualError as Error & { code?: string }).code = 'MANUAL_SIGNING_REQUIRED';
    mockSignCsr.mockRejectedValue(manualError);
    const { ctx } = makeCtx({ csr: 'csr-data', certificateType: 'V2GCertificate' });
    await handleSignCertificate(ctx);
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('logs error and returns Accepted when provider throws a generic error', async () => {
    mockSignCsr.mockRejectedValue(new Error('network timeout'));

    const { ctx, publishMock } = makeCtx({
      csr: 'csr-data',
      certificateType: 'ChargingStationCertificate',
    });
    const response = await handleSignCertificate(ctx);

    expect(response).toEqual({ status: 'Accepted' });
    // The initial event is published and the CSR ends rejected with the reason
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.SignCertificate' }),
    );
    expect(mockMarkFailed).toHaveBeenCalledWith(31, 'network timeout');
  });

  it('rejects V2GCertificate when PnC is disabled', async () => {
    vi.mocked(isPncEnabled).mockResolvedValueOnce(false);

    const { ctx, publishMock } = makeCtx({
      csr: 'csr-data',
      certificateType: 'V2GCertificate',
    });
    const response = await handleSignCertificate(ctx);

    expect(response).toEqual({ status: 'Rejected' });
    // No events published at all when rejected
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('accepts ChargingStationCertificate when PnC is disabled (SP3/mTLS renewal)', async () => {
    vi.mocked(isPncEnabled).mockResolvedValueOnce(false);

    const { ctx } = makeCtx({
      csr: 'csr-data',
      certificateType: 'ChargingStationCertificate',
    });
    const response = await handleSignCertificate(ctx);

    expect(response).toEqual({ status: 'Accepted' });
    // isPncEnabled should not have been called since certificateType is ChargingStationCertificate
    // The condition is: if (certificateType !== 'ChargingStationCertificate' && !(await isPncEnabled()))
    // Since the first part is false, isPncEnabled is not called (short-circuit)
  });

  it('publishes SignCertificate event with csr and certificateType from request', async () => {
    vi.mocked(isPncEnabled).mockResolvedValue(true);

    const { ctx, publishMock } = makeCtx({
      csr: 'my-csr-pem',
      certificateType: 'V2GCertificate',
    });
    const response = await handleSignCertificate(ctx);

    expect(response).toEqual({ status: 'Accepted' });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.SignCertificate',
        aggregateType: 'ChargingStation',
        aggregateId: 'CS-001',
        payload: expect.objectContaining({
          csr: 'my-csr-pem',
          certificateType: 'V2GCertificate',
        }) as unknown,
      }),
    );
  });

  it('handles getPkiProvider failure as a generic error', async () => {
    vi.mocked(getPkiProvider).mockRejectedValueOnce(new Error('provider init failed'));

    const { ctx } = makeCtx({
      csr: 'csr-data',
      certificateType: 'ChargingStationCertificate',
    });
    const response = await handleSignCertificate(ctx);

    // getPkiProvider throws, caught by the try/catch, logged as error, still returns Accepted
    expect(response).toEqual({ status: 'Accepted' });
  });

  it('rejects non-standard certificate type when PnC is disabled', async () => {
    vi.mocked(isPncEnabled).mockResolvedValueOnce(false);

    const { ctx } = makeCtx({
      csr: 'csr-data',
      certificateType: 'ManufacturerRootCertificate',
    });
    const response = await handleSignCertificate(ctx);

    expect(response).toEqual({ status: 'Rejected' });
  });
});
