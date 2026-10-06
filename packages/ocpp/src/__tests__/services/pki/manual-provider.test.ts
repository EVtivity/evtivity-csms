// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OcspRequestData } from '../../../services/pki/pki-provider.js';

const clientMock = vi.fn();

vi.mock('@evtivity/database', () => ({
  client: (...args: unknown[]) => clientMock(...args),
}));

const stationOcspMock = vi.fn();

vi.mock('../../../services/pki/ocsp.js', () => ({
  getOcspResultForStation: (...args: unknown[]) => stationOcspMock(...args) as unknown,
}));

import { ManualProvider } from '../../../services/pki/manual-provider.js';

type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

let fetchMock: FetchMock;

beforeEach(() => {
  clientMock.mockReset();
  stationOcspMock.mockReset();
  fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ManualProvider.signCsr', () => {
  it('inserts the CSR as pending and throws MANUAL_SIGNING_REQUIRED', async () => {
    clientMock.mockResolvedValueOnce([]);

    const provider = new ManualProvider();
    let thrown: (Error & { code?: string }) | null = null;
    try {
      await provider.signCsr('csr-pem', 'V2GCertificate', 'sta_1');
    } catch (err) {
      thrown = err as Error & { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.message).toBe('Manual signing required: CSR stored for operator review');
    expect(thrown?.code).toBe('MANUAL_SIGNING_REQUIRED');

    // The tagged-template call: first arg is the SQL strings array, then the
    // interpolated values in order (csr, certificateType, station ID).
    expect(clientMock).toHaveBeenCalledTimes(1);
    const callArgs = clientMock.mock.calls[0] as unknown[];
    const sqlStrings = callArgs[0] as string[];
    expect(sqlStrings.join('?')).toContain('INSERT INTO pki_csr_requests');
    expect(sqlStrings.join('?')).toContain("'pending'");
    expect(callArgs[1]).toBe('csr-pem');
    expect(callArgs[2]).toBe('V2GCertificate');
    expect(callArgs[3]).toBe('sta_1');
  });
});

describe('ManualProvider.getContractCertificate', () => {
  it('returns Failed with an empty exiResponse (unsupported in manual mode)', async () => {
    const provider = new ManualProvider();
    const result = await provider.getContractCertificate();

    expect(result).toEqual({ status: 'Failed', exiResponse: '' });
    expect(clientMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ManualProvider.getOcspStatus', () => {
  const ocspData: OcspRequestData = {
    hashAlgorithm: 'SHA256',
    issuerNameHash: 'aa'.repeat(32),
    issuerKeyHash: 'bb'.repeat(32),
    serialNumber: '1f',
    responderURL: 'https://ocsp.public-responder.com/check',
  };

  it('returns the DER OCSP response the shared RFC 6960 helper fetched', async () => {
    stationOcspMock.mockResolvedValueOnce({ status: 'Accepted', ocspResult: 'MIIB' });

    const result = await new ManualProvider().getOcspStatus(ocspData);

    expect(stationOcspMock).toHaveBeenCalledWith(ocspData);
    expect(result).toEqual({ status: 'Accepted', ocspResult: 'MIIB' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns Failed with an empty ocspResult when the helper fails', async () => {
    stationOcspMock.mockResolvedValueOnce({
      status: 'Failed',
      ocspResult: '',
      reason: 'OCSP responder returned HTTP 503',
    });

    const result = await new ManualProvider().getOcspStatus(ocspData);

    // The caller logs the failure with the station it serves.
    expect(result).toEqual({
      status: 'Failed',
      ocspResult: '',
      reason: 'OCSP responder returned HTTP 503',
    });
  });
});

describe('ManualProvider.getRootCertificates', () => {
  it('queries active CA certificates of the given type and returns their PEMs', async () => {
    clientMock.mockResolvedValueOnce([{ certificate: 'pem-1' }, { certificate: 'pem-2' }]);

    const provider = new ManualProvider();
    const certs = await provider.getRootCertificates('V2G');

    expect(certs).toEqual(['pem-1', 'pem-2']);

    expect(clientMock).toHaveBeenCalledTimes(1);
    const callArgs = clientMock.mock.calls[0] as unknown[];
    const sqlStrings = callArgs[0] as string[];
    expect(sqlStrings.join('?')).toContain('SELECT certificate FROM pki_ca_certificates');
    expect(sqlStrings.join('?')).toContain("status = 'active'");
    // The type value is interpolated into the query.
    expect(callArgs[1]).toBe('V2G');
  });

  it('returns an empty array when no active CA certificates exist', async () => {
    clientMock.mockResolvedValueOnce([]);

    const provider = new ManualProvider();
    const certs = await provider.getRootCertificates('MO');

    expect(certs).toEqual([]);
    expect(clientMock.mock.calls[0]?.[1]).toBe('MO');
  });
});
