// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OcspRequestData } from '../../../services/pki/pki-provider.js';

const clientMock = vi.fn();

vi.mock('@evtivity/database', () => ({
  client: (...args: unknown[]) => clientMock(...args),
}));

import { ManualProvider } from '../../../services/pki/manual-provider.js';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clientMock.mockReset();
  fetchMock = vi.fn();
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
      await provider.signCsr('csr-pem', 'V2GCertificate');
    } catch (err) {
      thrown = err as Error & { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.message).toBe('Manual signing required: CSR stored for operator review');
    expect(thrown?.code).toBe('MANUAL_SIGNING_REQUIRED');

    // The tagged-template call: first arg is the SQL strings array, then the
    // interpolated values in order (csr, certificateType).
    expect(clientMock).toHaveBeenCalledTimes(1);
    const callArgs = clientMock.mock.calls[0] as unknown[];
    const sqlStrings = callArgs[0] as string[];
    expect(sqlStrings.join('?')).toContain('INSERT INTO pki_csr_requests');
    expect(sqlStrings.join('?')).toContain("'pending'");
    expect(callArgs[1]).toBe('csr-pem');
    expect(callArgs[2]).toBe('V2GCertificate');
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
    issuerNameHash: 'name-hash',
    issuerKeyHash: 'key-hash',
    serialNumber: 'serial-1',
    responderURL: 'https://ocsp.public-responder.com/check',
  };

  function binaryResponse(ok: boolean, status: number, bytes: Buffer): Response {
    return {
      ok,
      status,
      arrayBuffer: vi
        .fn()
        .mockResolvedValue(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        ),
    } as unknown as Response;
  }

  it('posts the OCSP request to the responder and returns the base64 result', async () => {
    const ocspBytes = Buffer.from('ocsp-binary-response');
    fetchMock.mockResolvedValueOnce(binaryResponse(true, 200, ocspBytes));

    const provider = new ManualProvider();
    const result = await provider.getOcspStatus(ocspData);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ocsp.public-responder.com/check');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/ocsp-request' });

    const sentBody = init.body as Buffer;
    const decoded = JSON.parse(sentBody.toString('utf8')) as Record<string, string>;
    expect(decoded).toEqual({
      hashAlgorithm: 'SHA256',
      issuerNameHash: 'name-hash',
      issuerKeyHash: 'key-hash',
      serialNumber: 'serial-1',
    });

    expect(result).toEqual({
      status: 'Accepted',
      ocspResult: ocspBytes.toString('base64'),
    });
  });

  it('rejects a responder URL pointing at a private/internal address (SSRF guard)', async () => {
    const provider = new ManualProvider();
    const result = await provider.getOcspStatus({
      ...ocspData,
      responderURL: 'http://127.0.0.1:8080/ocsp',
    });

    expect(result).toEqual({ status: 'Failed', ocspResult: '' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns Failed when the fetch rejects (network error or timeout)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('aborted'));

    const provider = new ManualProvider();
    const result = await provider.getOcspStatus(ocspData);

    expect(result).toEqual({ status: 'Failed', ocspResult: '' });
  });

  it('returns Failed when the responder returns a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(binaryResponse(false, 503, Buffer.from('')));

    const provider = new ManualProvider();
    const result = await provider.getOcspStatus(ocspData);

    expect(result).toEqual({ status: 'Failed', ocspResult: '' });
  });

  it('aborts the OCSP request and returns Failed once the timeout elapses', async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const abortingFetch = (_url: string, init: RequestInit): Promise<Response> => {
      capturedSignal = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    };
    fetchMock.mockImplementation(abortingFetch);

    const provider = new ManualProvider();
    const resultPromise = provider.getOcspStatus(ocspData);

    await Promise.resolve();
    expect(capturedSignal?.aborted).toBe(false);

    // Advance past the 15s OCSP timeout to fire the abort and reject fetch.
    vi.advanceTimersByTime(15_000);
    const result = await resultPromise;

    expect(capturedSignal?.aborted).toBe(true);
    expect(result).toEqual({ status: 'Failed', ocspResult: '' });

    vi.useRealTimers();
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
