// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { AsnConvert } from '@peculiar/asn1-schema';
import { OCSPRequest, OCSPResponseStatus } from '@peculiar/asn1-ocsp';
import { BlockedDestinationError, type SafeFetchInit } from '@evtivity/lib';
import {
  buildResponse,
  errorResponse,
  issueCert,
  requestDataFor,
  type TestCert,
} from './ocsp-fixtures.js';

const allowedHostsMock = vi.fn<() => Promise<string[]>>();

vi.mock('@evtivity/database', () => ({
  getOcspAllowedPrivateHosts: () => allowedHostsMock(),
}));

type SafeFetchArgs = [url: string, init: SafeFetchInit];
const fetchMock = vi.fn<(...args: SafeFetchArgs) => Promise<Response>>();

// The connect-time DNS guard of safeFetch has its own tests in @evtivity/lib.
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  safeFetch: (...args: SafeFetchArgs) => fetchMock(...args),
}));

import {
  buildOcspRequest,
  certIdFor,
  getOcspResultForStation,
  isOcspResponderAllowed,
  normalizeSerialHex,
  OcspError,
  verifyOcspResponse,
  OCSP_MAX_AGE_WITHOUT_NEXT_UPDATE_MS,
  MAX_CHAIN_SIGNATURE_CHECKS,
  MAX_OCSP_CARRIED_CERTS,
} from '../../../services/pki/ocsp.js';

let root: TestCert;
let subCa: TestCert;
let leaf: TestCert;

beforeAll(async () => {
  root = await issueCert('CN=Test Root', null, { ca: true });
  subCa = await issueCert('CN=Test SubCA', root, { ca: true });
  leaf = await issueCert('CN=EMAID1', subCa, { ocspUrl: 'https://ocsp.example.com/' });
});

beforeEach(() => {
  allowedHostsMock.mockReset();
  allowedHostsMock.mockResolvedValue([]);
  fetchMock.mockReset();
});

/** A 200 reply that streams 16 KiB chunks without end, counting what was pulled. */
function endlessResponse(pulled: { bytes: number }, contentLength?: string): Response {
  const chunk = new Uint8Array(16 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/ocsp-response' };
  if (contentLength != null) headers['Content-Length'] = contentLength;
  return new Response(stream, { status: 200, headers });
}

function derResponse(body: Buffer, status = 200): Response {
  return new Response(new Uint8Array(body), {
    status,
    headers: { 'Content-Type': 'application/ocsp-response' },
  });
}

describe('buildOcspRequest', () => {
  it('encodes an RFC 6960 OCSPRequest with the CertID from the OCPP hashes', () => {
    const data = requestDataFor(leaf);
    const parsed = AsnConvert.parse(buildOcspRequest(data), OCSPRequest);
    const certId = parsed.tbsRequest.requestList[0]?.reqCert;
    expect(parsed.tbsRequest.requestList).toHaveLength(1);
    expect(certId?.hashAlgorithm.algorithm).toBe('2.16.840.1.101.3.4.2.1');
    expect(Buffer.from(certId?.issuerNameHash.buffer ?? new ArrayBuffer(0)).toString('hex')).toBe(
      data.issuerNameHash,
    );
    expect(Buffer.from(certId?.issuerKeyHash.buffer ?? new ArrayBuffer(0)).toString('hex')).toBe(
      data.issuerKeyHash,
    );
    expect(
      normalizeSerialHex(Buffer.from(certId?.serialNumber ?? new ArrayBuffer(0)).toString('hex')),
    ).toBe(data.serialNumber);
  });

  it('keeps a serial with the high bit set positive', () => {
    const der = buildOcspRequest({ ...requestDataFor(leaf), serialNumber: 'ff01' });
    const certId = AsnConvert.parse(der, OCSPRequest).tbsRequest.requestList[0]?.reqCert;
    expect(Buffer.from(certId?.serialNumber ?? new ArrayBuffer(0)).toString('hex')).toBe('00ff01');
  });

  it('rejects malformed hashes and unsupported algorithms', () => {
    expect(() => buildOcspRequest({ ...requestDataFor(leaf), issuerKeyHash: 'xyz' })).toThrow();
    expect(() => buildOcspRequest({ ...requestDataFor(leaf), hashAlgorithm: 'MD5' })).toThrow();
  });
});

describe('certIdFor', () => {
  it('computes the same CertID a station sends', () => {
    const { hashAlgorithm, issuerNameHash, issuerKeyHash, serialNumber } = requestDataFor(leaf);
    expect(certIdFor(leaf.asn, subCa.asn, 'SHA256')).toEqual({
      hashAlgorithm,
      issuerNameHash,
      issuerKeyHash,
      serialNumber,
    });
  });
});

describe('isOcspResponderAllowed', () => {
  it('allows public http(s) URLs', () => {
    expect(isOcspResponderAllowed('http://ocsp.example.com/', [])).toBe(true);
    expect(isOcspResponderAllowed('https://ocsp.example.com/x', [])).toBe(true);
  });

  it('blocks private addresses unless the host is allowlisted', () => {
    expect(isOcspResponderAllowed('http://10.0.0.5:7190/', [])).toBe(false);
    expect(isOcspResponderAllowed('http://host.docker.internal:7190/', [])).toBe(false);
    expect(
      isOcspResponderAllowed('http://host.docker.internal:7190/', ['host.docker.internal']),
    ).toBe(true);
    expect(isOcspResponderAllowed('http://[::1]:7190/', ['::1'])).toBe(true);
    expect(isOcspResponderAllowed('http://10.0.0.5/', ['10.0.0.6'])).toBe(false);
  });

  it('rejects non-http schemes and invalid URLs even when allowlisted', () => {
    expect(isOcspResponderAllowed('file:///etc/passwd', ['localhost'])).toBe(false);
    expect(isOcspResponderAllowed('not a url', ['localhost'])).toBe(false);
  });
});

describe('verifyOcspResponse', () => {
  it('returns good, revoked, or unknown for a response the issuer signed', () => {
    const data = requestDataFor(leaf);
    const req = buildOcspRequest(data);
    for (const status of ['good', 'revoked', 'unknown'] as const) {
      const res = buildResponse(req, { status, signer: subCa, includeCerts: [subCa] });
      expect(verifyOcspResponse(res, data, [root.asn])).toBe(status);
    }
  });

  it('finds the issuer among the known CA certificates when the response carries none', () => {
    const data = requestDataFor(leaf);
    const res = buildResponse(buildOcspRequest(data), { status: 'good', signer: subCa });
    expect(() => verifyOcspResponse(res, data, [])).toThrow(/Issuer/);
    expect(verifyOcspResponse(res, data, [subCa.asn])).toBe('good');
  });

  it('accepts a delegated responder the issuer certified for OCSP signing', async () => {
    const responder = await issueCert('CN=OCSP Responder', subCa, { ocspSigning: true });
    const data = requestDataFor(leaf);
    const res = buildResponse(buildOcspRequest(data), {
      status: 'revoked',
      signer: responder,
      includeCerts: [responder, subCa],
    });
    expect(verifyOcspResponse(res, data, [root.asn])).toBe('revoked');
  });

  it('rejects a responder without the OCSP signing purpose', async () => {
    const other = await issueCert('CN=Not a responder', subCa);
    const data = requestDataFor(leaf);
    const res = buildResponse(buildOcspRequest(data), {
      status: 'good',
      signer: other,
      includeCerts: [other, subCa],
    });
    expect(() => verifyOcspResponse(res, data, [root.asn])).toThrow(/not signed by the issuer/);
  });

  it('rejects a responder certificate the issuer did not sign', async () => {
    const otherRoot = await issueCert('CN=Other Root', null, { ca: true });
    const forged = await issueCert('CN=Test SubCA', otherRoot, { ca: true });
    const data = requestDataFor(leaf);
    const res = buildResponse(buildOcspRequest(data), {
      status: 'good',
      signer: forged,
      includeCerts: [forged],
    });
    expect(() => verifyOcspResponse(res, data, [])).toThrow();
  });

  it('refuses an old response without nextUpdate and a known CA outside its validity', async () => {
    const data = requestDataFor(leaf);
    const req = buildOcspRequest(data);
    const open = buildResponse(req, {
      status: 'good',
      signer: subCa,
      includeCerts: [subCa],
      nextUpdate: null,
    });
    expect(verifyOcspResponse(open, data, [root.asn])).toBe('good');
    const later = Date.now() + OCSP_MAX_AGE_WITHOUT_NEXT_UPDATE_MS + 60_000;
    expect(() => verifyOcspResponse(open, data, [root.asn], later)).toThrow(/thisUpdate/);

    const DAY = 24 * 60 * 60 * 1000;
    const oldRoot = await issueCert('CN=Expired Root', null, {
      ca: true,
      notBefore: new Date(Date.now() - 10 * DAY),
      notAfter: new Date(Date.now() - DAY),
    });
    const sub = await issueCert('CN=Sub Under Expired', oldRoot, { ca: true });
    const end = await issueCert('CN=End', sub);
    const endData = requestDataFor(end);
    const viaCarried = buildResponse(buildOcspRequest(endData), {
      status: 'good',
      signer: sub,
      includeCerts: [sub],
    });
    expect(() => verifyOcspResponse(viaCarried, endData, [oldRoot.asn])).toThrow();
    const subData = requestDataFor(sub);
    const direct = buildResponse(buildOcspRequest(subData), { status: 'good', signer: oldRoot });
    expect(() => verifyOcspResponse(direct, subData, [oldRoot.asn])).toThrow(/validity/);
  });

  it('rejects a bad signature, a stale response, and a non-successful status', () => {
    const data = requestDataFor(leaf);
    const req = buildOcspRequest(data);
    const tampered = buildResponse(req, {
      status: 'good',
      signer: subCa,
      includeCerts: [subCa],
      tamper: true,
    });
    expect(() => verifyOcspResponse(tampered, data, [root.asn])).toThrow(/signature/);
    const stale = buildResponse(req, {
      status: 'good',
      signer: subCa,
      includeCerts: [subCa],
      nextUpdate: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(() => verifyOcspResponse(stale, data, [root.asn])).toThrow(/stale/);
    expect(() => verifyOcspResponse(errorResponse(OCSPResponseStatus.tryLater), data, [])).toThrow(
      /tryLater/,
    );
  });

  it('rejects a response for another certificate', () => {
    const data = requestDataFor(leaf);
    const res = buildResponse(buildOcspRequest(data), {
      status: 'good',
      signer: subCa,
      includeCerts: [subCa],
    });
    expect(() => verifyOcspResponse(res, { ...data, serialNumber: '1234' }, [root.asn])).toThrow(
      /does not cover/,
    );
  });

  it('refuses an issuer carried only in the response, with no chain to a known CA', () => {
    const data = requestDataFor(leaf);
    const res = buildResponse(buildOcspRequest(data), {
      status: 'good',
      signer: subCa,
      includeCerts: [subCa],
    });
    expect(() => verifyOcspResponse(res, data, [])).toThrow(/no chain to a known CA/);
  });

  it('refuses an attacker CA carried in the response even with its own root included', async () => {
    const evilRoot = await issueCert('CN=Evil Root', null, { ca: true });
    const evilSub = await issueCert('CN=Evil SubCA', evilRoot, { ca: true });
    const evilLeaf = await issueCert('CN=EMAID2', evilSub, {
      ocspUrl: 'https://ocsp.example.com/',
    });
    const data = requestDataFor(evilLeaf);
    const res = buildResponse(buildOcspRequest(data), {
      status: 'good',
      signer: evilSub,
      includeCerts: [evilSub, evilRoot],
    });
    expect(() => verifyOcspResponse(res, data, [root.asn])).toThrow(/no chain to a known CA/);
  });

  it('accepts a carried issuer through a carried intermediate to a known root', async () => {
    const mid = await issueCert('CN=Test Mid', root, { ca: true });
    const lowSub = await issueCert('CN=Test LowSub', mid, { ca: true });
    const lowLeaf = await issueCert('CN=EMAID3', lowSub, { ocspUrl: 'https://ocsp.example.com/' });
    const data = requestDataFor(lowLeaf);
    const res = buildResponse(buildOcspRequest(data), {
      status: 'good',
      signer: lowSub,
      includeCerts: [lowSub, mid],
    });
    expect(verifyOcspResponse(res, data, [root.asn])).toBe('good');
  });

  it('chains a carried issuer through intermediates another response carried, never anchored by them', async () => {
    const mid = await issueCert('CN=Pool Mid', root, { ca: true });
    const lowSub = await issueCert('CN=Pool LowSub', mid, { ca: true });
    const lowLeaf = await issueCert('CN=EMAID5', lowSub, { ocspUrl: 'https://ocsp.example.com/' });
    const data = requestDataFor(lowLeaf);
    const res = buildResponse(buildOcspRequest(data), {
      status: 'good',
      signer: lowSub,
      includeCerts: [lowSub],
    });
    expect(() => verifyOcspResponse(res, data, [root.asn])).toThrow(/no chain to a known CA/);
    expect(verifyOcspResponse(res, data, [root.asn], Date.now(), [mid.asn])).toBe('good');
    // The root as an intermediate is no anchor.
    expect(() => verifyOcspResponse(res, data, [], Date.now(), [mid.asn, root.asn])).toThrow(
      /no chain to a known CA/,
    );
  });

  it('refuses a carried issuer under a known root whose pathLen 0 forbids the intermediate', async () => {
    const tightRoot = await issueCert('CN=Tight Root', null, { ca: true, pathLength: 0 });
    const inter = await issueCert('CN=Tight Inter', tightRoot, { ca: true });
    const tightIssuer = await issueCert('CN=Tight Issuer', inter, { ca: true });
    const l = await issueCert('CN=EMAID6', tightIssuer, { ocspUrl: 'https://ocsp.example.com/' });
    const data = requestDataFor(l);
    const res = buildResponse(buildOcspRequest(data), {
      status: 'good',
      signer: tightIssuer,
      includeCerts: [tightIssuer, inter],
    });
    expect(() => verifyOcspResponse(res, data, [tightRoot.asn])).toThrow(/no chain to a known CA/);
  });

  it('bounds the chain search over mutually signed same-subject carried CAs', async () => {
    const loop: Awaited<ReturnType<typeof issueCert>>[] = [];
    let prev = await issueCert('CN=Loop CA', null, { ca: true });
    loop.push(prev);
    for (let i = 1; i < MAX_OCSP_CARRIED_CERTS; i++) {
      prev = await issueCert('CN=Loop CA', prev, { ca: true });
      loop.push(prev);
    }
    const loopLeaf = await issueCert('CN=EMAID7', prev, { ocspUrl: 'https://ocsp.example.com/' });
    const data = requestDataFor(loopLeaf);
    const res = buildResponse(buildOcspRequest(data), {
      status: 'good',
      signer: prev,
      includeCerts: loop,
    });
    const verify = vi.spyOn(crypto, 'verify');
    const started = Date.now();
    try {
      expect(() => verifyOcspResponse(res, data, [root.asn])).toThrow(/no chain to a known CA/);
      expect(verify.mock.calls.length).toBeLessThanOrEqual(MAX_CHAIN_SIGNATURE_CHECKS);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      verify.mockRestore();
    }
  });

  it('refuses a response that carries more certificates than the cap', async () => {
    const data = requestDataFor(leaf);
    const extra = await Promise.all(
      Array.from({ length: MAX_OCSP_CARRIED_CERTS }, (_, i) =>
        issueCert(`CN=Extra ${String(i)}`, null),
      ),
    );
    const res = buildResponse(buildOcspRequest(data), {
      status: 'good',
      signer: subCa,
      includeCerts: [subCa, ...extra],
    });
    expect(() => verifyOcspResponse(res, data, [root.asn])).toThrow(/more than 8 certificates/);
  });

  it('refuses a carried CA certificate that is not a CA in the chain', async () => {
    const notCa = await issueCert('CN=Not a CA', root);
    const underNotCa = await issueCert('CN=Under Not CA', notCa, { ca: true });
    const l = await issueCert('CN=EMAID4', underNotCa, { ocspUrl: 'https://ocsp.example.com/' });
    const data = requestDataFor(l);
    const res = buildResponse(buildOcspRequest(data), {
      status: 'good',
      signer: underNotCa,
      includeCerts: [underNotCa, notCa],
    });
    expect(() => verifyOcspResponse(res, data, [root.asn])).toThrow(/no chain to a known CA/);
  });

  it('rejects a body that is not DER and keeps the parse error as the cause', () => {
    let thrown: unknown;
    try {
      verifyOcspResponse(Buffer.from('not der'), requestDataFor(leaf), []);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OcspError);
    expect((thrown as OcspError).message).toMatch(/DER OCSPResponse/);
    expect((thrown as OcspError).cause).toBeInstanceOf(Error);
  });
});

describe('getOcspResultForStation', () => {
  it('posts the DER request and returns the DER response base64 encoded', async () => {
    const data = requestDataFor(leaf);
    const res = buildResponse(buildOcspRequest(data), {
      status: 'good',
      signer: subCa,
      includeCerts: [subCa],
    });
    fetchMock.mockResolvedValueOnce(derResponse(res));

    const result = await getOcspResultForStation(data);

    expect(result).toEqual({ status: 'Accepted', ocspResult: res.toString('base64') });
    const [url, init] = fetchMock.mock.calls[0] as SafeFetchArgs;
    expect(url).toBe(data.responderURL);
    expect(init.allowedPrivateHosts).toEqual([]);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/ocsp-request',
    );
    expect(Buffer.from(init.body as Uint8Array)).toEqual(buildOcspRequest(data));
  });

  it('fails without a request for a private responder that is not allowlisted', async () => {
    const result = await getOcspResultForStation({
      ...requestDataFor(leaf),
      responderURL: 'http://127.0.0.1:7190/',
    });
    expect(result.status).toBe('Failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reaches a private responder in the allowlist', async () => {
    allowedHostsMock.mockResolvedValue(['127.0.0.1']);
    const data = { ...requestDataFor(leaf), responderURL: 'http://127.0.0.1:7190/' };
    const res = buildResponse(buildOcspRequest(data), { status: 'good', signer: subCa });
    fetchMock.mockResolvedValueOnce(derResponse(res));
    const result = await getOcspResultForStation(data);
    expect(result.status).toBe('Accepted');
    expect(fetchMock.mock.calls[0]?.[1].allowedPrivateHosts).toEqual(['127.0.0.1']);
  });

  it('fails when the responder name resolves to a private address at connect time', async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError('fetch failed', {
        cause: new BlockedDestinationError('ocsp.example.com', '10.0.0.5'),
      }),
    );
    const result = await getOcspResultForStation(requestDataFor(leaf));
    expect(result).toMatchObject({
      status: 'Failed',
      reason: expect.stringMatching(/10\.0\.0\.5.*pnc\.ocsp\.allowedPrivateHosts/),
    });
  });

  it('fails on HTTP errors, network errors, non-OCSP bodies, and error statuses', async () => {
    const data = requestDataFor(leaf);
    fetchMock.mockResolvedValueOnce(derResponse(Buffer.from('x'), 503));
    expect((await getOcspResultForStation(data)).status).toBe('Failed');
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await getOcspResultForStation(data)).status).toBe('Failed');
    fetchMock.mockResolvedValueOnce(derResponse(Buffer.from('{"json":true}')));
    expect((await getOcspResultForStation(data)).status).toBe('Failed');
    fetchMock.mockResolvedValueOnce(derResponse(errorResponse(OCSPResponseStatus.unauthorized)));
    const unauthorized = await getOcspResultForStation(data);
    expect(unauthorized).toMatchObject({
      status: 'Failed',
      reason: expect.stringMatching(/unauthorized/),
    });
  });

  it('stops reading an oversized streamed body at the cap', async () => {
    const pulled = { bytes: 0 };
    fetchMock.mockResolvedValueOnce(endlessResponse(pulled));
    const result = await getOcspResultForStation(requestDataFor(leaf));
    expect(result).toMatchObject({ status: 'Failed', reason: expect.stringMatching(/exceeds/) });
    // The 64 KiB cap plus the chunk that crossed it and the one the stream
    // queued ahead, not the endless body.
    expect(pulled.bytes).toBeLessThanOrEqual(64 * 1024 + 2 * 16 * 1024);
  });

  it('refuses a declared Content-Length above the cap without reading', async () => {
    const pulled = { bytes: 0 };
    fetchMock.mockResolvedValueOnce(endlessResponse(pulled, String(5 * 1024 * 1024)));
    expect((await getOcspResultForStation(requestDataFor(leaf))).status).toBe('Failed');
    expect(pulled.bytes).toBeLessThanOrEqual(16 * 1024);
  });

  it('aborts after the timeout', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const pending = getOcspResultForStation(requestDataFor(leaf));
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).status).toBe('Failed');
    vi.useRealTimers();
  });
});
