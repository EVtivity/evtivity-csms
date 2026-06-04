// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HubjectProvider } from '../../../services/pki/hubject-provider.js';
import type { OcspRequestData } from '../../../services/pki/pki-provider.js';

const config = {
  baseUrl: 'https://hubject.example.com',
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
  tokenUrl: 'https://hubject.example.com/oauth/token',
};

function tokenResponse(accessToken = 'token-123', expiresIn = 3600): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ access_token: accessToken, expires_in: expiresIn }),
    text: vi.fn(),
    arrayBuffer: vi.fn(),
  } as unknown as Response;
}

function textResponse(ok: boolean, status: number, body: string): Response {
  return {
    ok,
    status,
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn(),
    arrayBuffer: vi.fn(),
  } as unknown as Response;
}

function jsonResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: vi.fn(),
  } as unknown as Response;
}

function binaryResponse(ok: boolean, status: number, bytes: Buffer): Response {
  return {
    ok,
    status,
    arrayBuffer: vi
      .fn()
      .mockResolvedValue(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    text: vi.fn().mockResolvedValue(''),
    json: vi.fn(),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HubjectProvider OAuth2 token flow', () => {
  it('fetches an access token with client_credentials and caches it across calls', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('cached-token', 3600))
      .mockResolvedValueOnce(textResponse(true, 200, 'cert-chain-pem'))
      .mockResolvedValueOnce(textResponse(true, 200, 'cert-chain-pem-2'));

    const provider = new HubjectProvider(config);
    await provider.signCsr('csr-1', 'V2GCertificate');
    await provider.signCsr('csr-2', 'V2GCertificate');

    // Token fetched once (call 0), reused for both signCsr calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe('https://hubject.example.com/oauth/token');
    expect(tokenInit.method).toBe('POST');
    expect(tokenInit.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    const sentParams = new URLSearchParams(tokenInit.body as string);
    expect(sentParams.get('grant_type')).toBe('client_credentials');
    expect(sentParams.get('client_id')).toBe('client-abc');
    expect(sentParams.get('client_secret')).toBe('secret-xyz');

    // Both signCsr requests carried the same bearer token.
    const firstSignInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const secondSignInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect((firstSignInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer cached-token',
    );
    expect((secondSignInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer cached-token',
    );
  });

  it('refreshes the token when the cached one is within 60s of expiry', async () => {
    // expires_in: 30 means the cache expires_at is only 30s out, which is
    // inside the 60s refresh guard, forcing a refresh on the next call.
    fetchMock
      .mockResolvedValueOnce(tokenResponse('short-token', 30))
      .mockResolvedValueOnce(textResponse(true, 200, 'chain-1'))
      .mockResolvedValueOnce(tokenResponse('fresh-token', 3600))
      .mockResolvedValueOnce(textResponse(true, 200, 'chain-2'));

    const provider = new HubjectProvider(config);
    await provider.signCsr('csr-1', 'V2GCertificate');
    await provider.signCsr('csr-2', 'V2GCertificate');

    // Two token fetches (calls 0 and 2) because the first token was near-expiry.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(config.tokenUrl);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(config.tokenUrl);

    const secondSignInit = fetchMock.mock.calls[3]?.[1] as RequestInit;
    expect((secondSignInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer fresh-token',
    );
  });

  it('throws when the OAuth2 token request returns a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(false, 401, 'invalid client'));

    const provider = new HubjectProvider(config);
    await expect(provider.getRootCertificates('V2G')).rejects.toThrow(
      'Hubject OAuth2 token request failed: 401 invalid client',
    );
  });
});

describe('HubjectProvider.signCsr', () => {
  it('posts the CSR to EST simpleenroll and returns the certificate chain', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok', 3600))
      .mockResolvedValueOnce(
        textResponse(true, 200, '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----'),
      );

    const provider = new HubjectProvider(config);
    const result = await provider.signCsr('my-csr', 'ChargingStationCertificate');

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://hubject.example.com/.well-known/est/simpleenroll');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('my-csr');
    expect(init.headers).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/pkcs10',
    });

    expect(result.certificateChain).toBe(
      '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----',
    );
    expect(result.providerReference).toMatch(/^hubject-est-\d+$/);
  });

  it('throws with status and body when EST signing fails', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok', 3600))
      .mockResolvedValueOnce(textResponse(false, 422, 'bad csr'));

    const provider = new HubjectProvider(config);
    await expect(provider.signCsr('my-csr', 'V2GCertificate')).rejects.toThrow(
      'Hubject CSR signing failed: 422 bad csr',
    );
  });
});

describe('HubjectProvider.getContractCertificate', () => {
  it('posts the EXI request as JSON and returns Accepted with the exiResponse', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok', 3600))
      .mockResolvedValueOnce(jsonResponse(true, 200, { exiResponse: 'exi-out' }));

    const provider = new HubjectProvider(config);
    const result = await provider.getContractCertificate('exi-in');

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://hubject.example.com/ccp/getSignedContractData');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
    expect(init.body).toBe(JSON.stringify({ exiRequest: 'exi-in' }));

    expect(result).toEqual({ status: 'Accepted', exiResponse: 'exi-out' });
  });

  it('returns Failed with empty exiResponse on a non-2xx response', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok', 3600))
      .mockResolvedValueOnce(textResponse(false, 500, 'ccp down'));

    const provider = new HubjectProvider(config);
    const result = await provider.getContractCertificate('exi-in');

    expect(result).toEqual({ status: 'Failed', exiResponse: '' });
  });
});

describe('HubjectProvider.getOcspStatus', () => {
  const ocspData: OcspRequestData = {
    hashAlgorithm: 'SHA256',
    issuerNameHash: 'name-hash',
    issuerKeyHash: 'key-hash',
    serialNumber: 'serial-1',
    responderURL: 'https://ocsp.public-responder.com/check',
  };

  it('posts a base64 OCSP request to the responder and returns the base64 result', async () => {
    const ocspBytes = Buffer.from('ocsp-binary-response');
    fetchMock.mockResolvedValueOnce(binaryResponse(true, 200, ocspBytes));

    const provider = new HubjectProvider(config);
    const result = await provider.getOcspStatus(ocspData);

    // No OAuth token fetch on the OCSP path; it goes straight to the responder.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ocsp.public-responder.com/check');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/ocsp-request' });

    // The body is the decoded form of a base64-encoded JSON OCSP request.
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
    const provider = new HubjectProvider(config);
    const result = await provider.getOcspStatus({
      ...ocspData,
      responderURL: 'http://169.254.169.254/latest/meta-data',
    });

    expect(result).toEqual({ status: 'Failed', ocspResult: '' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns Failed when the OCSP responder returns a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(binaryResponse(false, 503, Buffer.from('')));

    const provider = new HubjectProvider(config);
    const result = await provider.getOcspStatus(ocspData);

    expect(result).toEqual({ status: 'Failed', ocspResult: '' });
  });
});

describe('HubjectProvider request timeout', () => {
  it('aborts the request signal once the timeout elapses', async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const hangingFetch = (_url: string, init: RequestInit): Promise<Response> => {
      capturedSignal = init.signal ?? undefined;
      // Never resolve while the timer runs; we only care that the abort fires.
      return new Promise<Response>(() => {
        /* hang */
      });
    };
    fetchMock.mockImplementation(hangingFetch);

    const provider = new HubjectProvider(config);
    void provider.getRootCertificates('V2G');

    // Let the synchronous fetch call run so the signal is captured.
    await Promise.resolve();
    expect(capturedSignal?.aborted).toBe(false);

    // Advance past the 30s Hubject timeout; the abort callback fires.
    vi.advanceTimersByTime(30_000);
    expect(capturedSignal?.aborted).toBe(true);

    vi.useRealTimers();
  });
});

describe('HubjectProvider.getRootCertificates', () => {
  it('fetches the EST cacerts bundle and splits it into individual PEMs', async () => {
    const bundle =
      '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n' +
      '-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----\n';
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok', 3600))
      .mockResolvedValueOnce(textResponse(true, 200, bundle));

    const provider = new HubjectProvider(config);
    const certs = await provider.getRootCertificates('V2G');

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://hubject.example.com/.well-known/est/cacerts');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/pkcs10',
    });

    expect(certs).toEqual([
      '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----',
      '-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----',
    ]);
  });

  it('returns an empty array when the bundle has no certificates', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok', 3600))
      .mockResolvedValueOnce(textResponse(true, 200, 'no certs here'));

    const provider = new HubjectProvider(config);
    const certs = await provider.getRootCertificates('V2G');

    expect(certs).toEqual([]);
  });

  it('throws with status and body when the cacerts fetch fails', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok', 3600))
      .mockResolvedValueOnce(textResponse(false, 404, 'not found'));

    const provider = new HubjectProvider(config);
    await expect(provider.getRootCertificates('V2G')).rejects.toThrow(
      'Hubject root cert fetch failed: 404 not found',
    );
  });
});
