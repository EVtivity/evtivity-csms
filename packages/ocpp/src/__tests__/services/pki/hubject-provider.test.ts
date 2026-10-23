// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as x509 from '@peculiar/x509';
const stationOcspMock = vi.fn();

vi.mock('../../../services/pki/ocsp.js', () => ({
  getOcspResultForStation: (...args: unknown[]) => stationOcspMock(...args) as unknown,
}));

// The connect-time address check of safeFetch has its own tests in @evtivity/lib.
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  safeFetch: (...args: unknown[]) => (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
}));

import {
  HUBJECT_ERROR_BODY_BYTES,
  HUBJECT_MAX_RESPONSE_BYTES,
  HubjectProvider,
} from '../../../services/pki/hubject-provider.js';
import type { OcspRequestData } from '../../../services/pki/pki-provider.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

/** A CA and a leaf it issued for a CSR, as the EST server would return them. */
async function caAndLeaf(): Promise<{
  ca: x509.X509Certificate;
  leaf: x509.X509Certificate;
  csrPem: string;
}> {
  const caKeys = (await webcrypto.subtle.generateKey(ALG, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const leafKeys = (await webcrypto.subtle.generateKey(ALG, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 86_400_000);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=Test CPO Sub-CA',
    notBefore,
    notAfter,
    keys: caKeys,
    signingAlgorithm: ALG,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: 'CN=CS-001',
    issuer: ca.subject,
    notBefore,
    notAfter,
    publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey,
    signingAlgorithm: ALG,
  });
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=CS-001',
    keys: leafKeys,
    signingAlgorithm: ALG,
  });
  return { ca, leaf, csrPem: csr.toString('pem') };
}

// A CSR and the leaf the EST server signed for its key.
let signed: { csrPem: string; leafPem: string };
beforeAll(async () => {
  const { leaf, csrPem } = await caAndLeaf();
  signed = { csrPem, leafPem: leaf.toString('pem') };
});

const config = {
  baseUrl: 'https://hubject.example.com',
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
  tokenUrl: 'https://hubject.example.com/oauth/token',
};

function tokenResponse(accessToken = 'token-123', expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
    status: 200,
  });
}

function textResponse(_ok: boolean, status: number, body: string): Response {
  return new Response(body, { status });
}

function jsonResponse(_ok: boolean, status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

let fetchMock: FetchMock;

beforeEach(() => {
  stationOcspMock.mockReset();
  fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
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
      .mockResolvedValueOnce(textResponse(true, 200, signed.leafPem))
      .mockResolvedValueOnce(textResponse(true, 200, signed.leafPem));

    const provider = new HubjectProvider(config);
    await provider.signCsr(signed.csrPem, 'V2GCertificate');
    await provider.signCsr(signed.csrPem, 'V2GCertificate');

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
      .mockResolvedValueOnce(textResponse(true, 200, signed.leafPem))
      .mockResolvedValueOnce(tokenResponse('fresh-token', 3600))
      .mockResolvedValueOnce(textResponse(true, 200, signed.leafPem));

    const provider = new HubjectProvider(config);
    await provider.signCsr(signed.csrPem, 'V2GCertificate');
    await provider.signCsr(signed.csrPem, 'V2GCertificate');

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
  it('posts the base64 DER CSR to EST simpleenroll and returns a PEM chain from the leaf', async () => {
    const { ca, leaf, csrPem } = await caAndLeaf();
    // RFC 7030: certs-only PKCS#7, base64 with line breaks, CA first on purpose.
    const pkcs7 = new x509.X509Certificates([ca, leaf])
      .toString('base64')
      .replace(/(.{64})/g, '$1\r\n');
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok', 3600))
      .mockResolvedValueOnce(textResponse(true, 200, pkcs7));

    const provider = new HubjectProvider(config);
    const result = await provider.signCsr(csrPem, 'V2GCertificate');

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://hubject.example.com/.well-known/est/simpleenroll');
    expect(init.method).toBe('POST');
    // Through safeFetch, without following a redirect.
    expect(init.redirect).toBe('error');
    expect(init.body).toBe(
      csrPem.replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, '').replace(/\s+/g, ''),
    );
    expect(init.headers).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/pkcs10',
      'Content-Transfer-Encoding': 'base64',
      Accept: 'application/pkcs7-mime',
    });

    expect(result.certificateChain).toBe(`${leaf.toString('pem')}\n${ca.toString('pem')}`);
    expect(result.providerReference).toMatch(/^hubject-est-\d+$/);
  });

  it('keeps a PEM response as it is', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok', 3600))
      .mockResolvedValueOnce(textResponse(true, 200, `${signed.leafPem}\n`));
    const provider = new HubjectProvider(config);
    const result = await provider.signCsr(signed.csrPem, 'V2GCertificate');
    expect(result.certificateChain).toBe(signed.leafPem.trim());
  });

  it('leaves a station TLS certificate to the operator', async () => {
    const provider = new HubjectProvider(config);
    await expect(
      provider.signCsr(signed.csrPem, 'ChargingStationCertificate'),
    ).rejects.toMatchObject({ code: 'MANUAL_SIGNING_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a returned leaf that carries another public key', async () => {
    const other = await caAndLeaf();
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok', 3600))
      .mockResolvedValueOnce(textResponse(true, 200, other.leaf.toString('pem')));
    const provider = new HubjectProvider(config);
    await expect(provider.signCsr(signed.csrPem, 'V2GCertificate')).rejects.toThrow(/public key/);
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
    const result = await provider.getContractCertificate({
      stationDbId: 'sta_1',
      iso15118SchemaVersion: 'urn:iso:15118:2:2013:MsgDef',
      action: 'Install',
      exiRequest: 'exi-in',
    });

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
    const result = await provider.getContractCertificate({
      stationDbId: 'sta_1',
      iso15118SchemaVersion: 'urn:iso:15118:2:2013:MsgDef',
      action: 'Install',
      exiRequest: 'exi-in',
    });

    expect(result).toEqual({ status: 'Failed', exiResponse: '' });
  });
});

describe('HubjectProvider.getOcspStatus', () => {
  const ocspData: OcspRequestData = {
    hashAlgorithm: 'SHA256',
    issuerNameHash: 'aa'.repeat(32),
    issuerKeyHash: 'bb'.repeat(32),
    serialNumber: '1f',
    responderURL: 'https://ocsp.public-responder.com/check',
  };

  it('returns the DER OCSP response the shared RFC 6960 helper fetched', async () => {
    stationOcspMock.mockResolvedValueOnce({ status: 'Accepted', ocspResult: 'MIIB' });

    const result = await new HubjectProvider(config).getOcspStatus(ocspData);

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

    const result = await new HubjectProvider(config).getOcspStatus(ocspData);

    // The caller logs the failure with the station it serves.
    expect(result).toEqual({
      status: 'Failed',
      ocspResult: '',
      reason: 'OCSP responder returned HTTP 503',
    });
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
      Accept: 'application/pkcs7-mime',
    });

    expect(certs).toEqual([
      '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----',
      '-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----',
    ]);
  });

  it('reads an RFC 7030 certs-only PKCS#7 bundle', async () => {
    const { ca, leaf } = await caAndLeaf();
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok', 3600))
      .mockResolvedValueOnce(
        textResponse(true, 200, new x509.X509Certificates([ca, leaf]).toString('base64')),
      );

    const provider = new HubjectProvider(config);
    const certs = await provider.getRootCertificates('V2G');

    expect(certs).toEqual([ca.toString('pem'), leaf.toString('pem')]);
  });

  it('fails on a body that is neither PEM nor PKCS#7', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok', 3600))
      .mockResolvedValueOnce(textResponse(true, 200, 'no certs here'));

    const provider = new HubjectProvider(config);
    await expect(provider.getRootCertificates('V2G')).rejects.toThrow();
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

// Hubject replies are read capped, and
// an error body is kept to a prefix.
describe('HubjectProvider reply bounds', () => {
  it('refuses a reply over the cap', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(textResponse(true, 200, 'A'.repeat(HUBJECT_MAX_RESPONSE_BYTES + 1)));
    const provider = new HubjectProvider(config);
    await expect(provider.getRootCertificates('V2GRootCertificate')).rejects.toThrow(/exceeds/);
  });

  it('keeps only a prefix of an error body', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(false, 500, 'E'.repeat(100_000)));
    const provider = new HubjectProvider(config);
    const err = await provider.getRootCertificates('V2GRootCertificate').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.length).toBeLessThan(HUBJECT_ERROR_BODY_BYTES + 200);
  });
});
