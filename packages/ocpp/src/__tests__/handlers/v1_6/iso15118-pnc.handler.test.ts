// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';

const { pncEnabled, sign, ev, status, authorize } = vi.hoisted(() => ({
  pncEnabled: vi.fn(),
  sign: vi.fn(),
  ev: vi.fn(),
  status: vi.fn(),
  authorize: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({ isPncEnabled: pncEnabled }));
vi.mock('../../../handlers/v2_1/sign-certificate.handler.js', () => ({
  handleSignCertificate: sign,
}));
vi.mock('../../../handlers/v2_1/get-15118-ev-certificate.handler.js', () => ({
  handleGet15118EVCertificate: ev,
}));
vi.mock('../../../handlers/v2_1/get-certificate-status.handler.js', () => ({
  handleGetCertificateStatus: status,
}));
vi.mock('../../../handlers/v2_1/authorize.handler.js', () => ({ handleAuthorize: authorize }));

const { handleDataTransfer } = await import('../../../handlers/v1_6/data-transfer.handler.js');

const VENDOR = 'org.openchargealliance.iso15118pnc';
const CSR = '-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----';
const HASH = {
  hashAlgorithm: 'SHA256',
  issuerNameHash: 'aa',
  issuerKeyHash: 'bb',
  serialNumber: '1f',
  responderURL: 'http://ocsp.example.com',
};

function ctx(messageId: string, data: unknown): HandlerContext {
  return {
    stationId: 'CS-16',
    stationDbId: 'sta_16',
    protocolVersion: 'ocpp1.6',
    payload: {
      vendorId: VENDOR,
      messageId,
      data: typeof data === 'string' ? data : JSON.stringify(data),
    },
    logger: pino({ level: 'silent' }),
    eventBus: { publish: vi.fn().mockResolvedValue(undefined) },
  } as unknown as HandlerContext;
}

function answer(res: Record<string, unknown>): unknown {
  return JSON.parse(String(res['data']));
}

beforeEach(() => {
  vi.clearAllMocks();
  pncEnabled.mockResolvedValue(true);
});

describe('1.6 ISO 15118 DataTransfer (OCA application note)', () => {
  it('runs SignCertificate through the 2.1 handler as a V2G certificate request', async () => {
    sign.mockResolvedValue({ status: 'Accepted' });
    const res = await handleDataTransfer(ctx('SignCertificate', { csr: CSR }));
    expect(res['status']).toBe('Accepted');
    expect(answer(res)).toEqual({ status: 'Accepted' });
    const inner = sign.mock.calls[0]?.[0] as HandlerContext;
    expect(inner.payload).toEqual({ csr: CSR, certificateType: 'V2GCertificate' });
    expect(inner.stationId).toBe('CS-16');
  });

  it('refuses a station certificate request in the DataTransfer (2.3)', async () => {
    const res = await handleDataTransfer(
      ctx('SignCertificate', { csr: CSR, certificateType: 'ChargingStationCertificate' }),
    );
    expect(res).toEqual({ status: 'Rejected' });
    expect(sign).not.toHaveBeenCalled();
  });

  it('answers Get15118EVCertificate without remainingContracts', async () => {
    ev.mockResolvedValue({ status: 'Accepted', exiResponse: 'EXI', remainingContracts: 0 });
    const res = await handleDataTransfer(
      ctx('Get15118EVCertificate', {
        iso15118SchemaVersion: 'urn:iso:15118:2:2013:MsgDef',
        action: 'Install',
        exiRequest: 'AAAA',
      }),
    );
    expect(answer(res)).toEqual({ status: 'Accepted', exiResponse: 'EXI' });
  });

  it('omits ocspResult unless GetCertificateStatus is Accepted', async () => {
    status.mockResolvedValueOnce({ status: 'Failed', ocspResult: '' });
    const failed = await handleDataTransfer(ctx('GetCertificateStatus', { ocspRequestData: HASH }));
    expect(answer(failed)).toEqual({ status: 'Failed' });
    status.mockResolvedValueOnce({ status: 'Accepted', ocspResult: 'MIIB' });
    const ok = await handleDataTransfer(ctx('GetCertificateStatus', { ocspRequestData: HASH }));
    expect(answer(ok)).toEqual({ status: 'Accepted', ocspResult: 'MIIB' });
  });

  it('authorizes the eMAID with the 2.1 C07 check and answers the note statuses', async () => {
    authorize.mockResolvedValue({
      idTokenInfo: { status: 'Unknown' },
      certificateStatus: 'ContractCancelled',
      tariff: { id: 't' },
    });
    const res = await handleDataTransfer(
      ctx('Authorize', {
        idToken: { idToken: 'USEVTC12345678' },
        iso15118CertificateHashData: [HASH],
      }),
    );
    const inner = authorize.mock.calls[0]?.[0] as HandlerContext;
    expect(inner.payload).toEqual({
      idToken: { idToken: 'USEVTC12345678', type: 'eMAID' },
      iso15118CertificateHashData: [HASH],
    });
    expect(answer(res)).toEqual({
      idTokenInfo: { status: 'Invalid' },
      certificateStatus: 'ContractCancelled',
    });
  });

  it('keeps Accepted with its cache expiry', async () => {
    authorize.mockResolvedValue({
      idTokenInfo: { status: 'Accepted', cacheExpiryDateTime: '2026-10-15T00:00:00Z' },
      certificateStatus: 'Accepted',
    });
    const res = await handleDataTransfer(
      ctx('Authorize', { idToken: { idToken: 'USEVTC12345678' }, certificate: 'PEM' }),
    );
    expect(answer(res)).toEqual({
      idTokenInfo: { status: 'Accepted', cacheExpiryDateTime: '2026-10-15T00:00:00Z' },
      certificateStatus: 'Accepted',
    });
  });

  it('rejects everything while Plug and Charge is off (note 2.1)', async () => {
    pncEnabled.mockResolvedValue(false);
    expect(await handleDataTransfer(ctx('SignCertificate', { csr: CSR }))).toEqual({
      status: 'Rejected',
    });
    expect(sign).not.toHaveBeenCalled();
  });

  it('answers UnknownMessageId, and Rejected for invalid or CSMS-initiated messages', async () => {
    expect(await handleDataTransfer(ctx('Heartbeat', {}))).toEqual({
      status: 'UnknownMessageId',
    });
    expect(await handleDataTransfer(ctx('CertificateSigned', { certificateChain: 'PEM' }))).toEqual(
      {
        status: 'Rejected',
      },
    );
    expect(await handleDataTransfer(ctx('SignCertificate', 'not json'))).toEqual({
      status: 'Rejected',
    });
    expect(await handleDataTransfer(ctx('Get15118EVCertificate', { action: 'Install' }))).toEqual({
      status: 'Rejected',
    });
    expect(ev).not.toHaveBeenCalled();
  });

  it('keeps UnknownVendorId for other vendors', async () => {
    const c = ctx('SignCertificate', { csr: CSR });
    c.payload['vendorId'] = 'com.example';
    expect(await handleDataTransfer(c)).toEqual({ status: 'UnknownVendorId' });
  });
});
