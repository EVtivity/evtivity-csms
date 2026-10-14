// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as x509 from '@peculiar/x509';
import pino from 'pino';

const { safeFetchMock, fetchOcspMock, verifyOcspMock, localStatusMock, issuersMock } = vi.hoisted(
  () => ({
    safeFetchMock: vi.fn(),
    fetchOcspMock: vi.fn(),
    verifyOcspMock: vi.fn(),
    localStatusMock: vi.fn(),
    issuersMock: vi.fn(),
  }),
);

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  safeFetch: safeFetchMock,
}));
vi.mock('@evtivity/database', () => ({
  getOcspAllowedPrivateHosts: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../services/pki/ocsp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/pki/ocsp.js')>()),
  fetchOcspResponse: fetchOcspMock,
  verifyOcspResponse: verifyOcspMock,
}));
vi.mock('../../../services/pki/local-contract-status.js', () => ({
  localCertificateStatus: localStatusMock,
}));
vi.mock('../../../services/pki/contract-certificate-validation.js', () => ({
  knownCertificateIssuers: issuersMock,
}));

const { getCertificateChainStatus, statusFromCrl } =
  await import('../../../services/pki/certificate-chain-status.js');
const { certIdFor, parseCertificate } = await import('../../../services/pki/ocsp.js');

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const logger = pino({ level: 'silent' });

let caKeys: CryptoKeyPair;
let ca: x509.X509Certificate;
let leaf: x509.X509Certificate;

async function crl(
  entries: string[],
  nextUpdate: Date | null = new Date(Date.now() + 3_600_000),
  keys = caKeys,
): Promise<Buffer> {
  const list = await x509.X509CrlGenerator.create({
    issuer: ca.subject,
    thisUpdate: new Date(Date.now() - 60_000),
    ...(nextUpdate != null ? { nextUpdate } : {}),
    entries: entries.map((serialNumber) => ({ serialNumber, revocationDate: new Date() })),
    signingKey: keys.privateKey,
    signingAlgorithm: ALG,
  });
  return Buffer.from(list.rawData);
}

function certId(): ReturnType<typeof certIdFor> {
  return certIdFor(
    parseCertificate(leaf.toString('pem')),
    parseCertificate(ca.toString('pem')),
    'SHA256',
  );
}

function fetchAnswer(body: Buffer): unknown {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () =>
      Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.length)),
  };
}

beforeAll(async () => {
  caKeys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const leafKeys = (await webcrypto.subtle.generateKey(ALG, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 86_400_000);
  ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=Test MO Sub-CA 2',
    notBefore,
    notAfter,
    keys: caKeys,
    signingAlgorithm: ALG,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  leaf = await x509.X509CertificateGenerator.create({
    serialNumber: '0abc',
    subject: 'CN=USEVTC12345678',
    issuer: ca.subject,
    notBefore,
    notAfter,
    publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey,
    signingAlgorithm: ALG,
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  localStatusMock.mockResolvedValue(null);
  issuersMock.mockResolvedValue([parseCertificate(ca.toString('pem'))]);
});

describe('statusFromCrl', () => {
  it('answers Good for a serial the CRL does not list and Revoked for one it lists', async () => {
    const issuers = [parseCertificate(ca.toString('pem'))];
    const next = new Date(Date.now() + 3_600_000);
    expect((await statusFromCrl(await crl(['0def'], next), certId(), issuers)).status).toBe('Good');
    const revoked = await statusFromCrl(await crl(['0abc']), certId(), issuers);
    expect(revoked.status).toBe('Revoked');
  });

  it('refuses a CRL another key signed', async () => {
    const otherKeys = (await webcrypto.subtle.generateKey(ALG, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    await expect(
      statusFromCrl(await crl([], undefined, otherKeys), certId(), [
        parseCertificate(ca.toString('pem')),
      ]),
    ).rejects.toThrow('CRL signature is invalid');
  });

  it('refuses a stale CRL and an unknown issuer', async () => {
    const issuers = [parseCertificate(ca.toString('pem'))];
    await expect(
      statusFromCrl(await crl([], new Date(Date.now() - 3_600_000)), certId(), issuers),
    ).rejects.toThrow('stale');
    await expect(statusFromCrl(await crl([]), certId(), [])).rejects.toThrow('Issuer');
    await expect(statusFromCrl(await crl(['0abc'], null), certId(), issuers)).rejects.toThrow(
      'no nextUpdate',
    );
  });
});

describe('getCertificateChainStatus', () => {
  it('checks a CRL source through the download guard (M07.FR.04 to FR.07)', async () => {
    safeFetchMock.mockResolvedValueOnce(fetchAnswer(await crl(['0abc'])));
    const [entry] = await getCertificateChainStatus(
      [{ source: 'CRL', urls: ['https://crl.example.com/mo.crl'], certificateHashData: certId() }],
      logger,
    );
    expect(entry).toMatchObject({ source: 'CRL', status: 'Revoked' });
    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://crl.example.com/mo.crl',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it('answers Failed when no CRL URL can be used (M07.FR.05)', async () => {
    const [entry] = await getCertificateChainStatus(
      [{ source: 'CRL', urls: ['http://10.0.0.5/mo.crl'], certificateHashData: certId() }],
      logger,
    );
    expect(entry?.status).toBe('Failed');
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('uses the OCSP status of the first responder that answers (M07.FR.01 to FR.03)', async () => {
    fetchOcspMock
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockResolvedValueOnce(Buffer.from('der'));
    verifyOcspMock.mockReturnValueOnce('revoked');
    const [entry] = await getCertificateChainStatus(
      [
        {
          source: 'OCSP',
          urls: ['https://a.example.com', 'https://b.example.com'],
          certificateHashData: certId(),
        },
      ],
      logger,
    );
    expect(entry).toMatchObject({ source: 'OCSP', status: 'Revoked' });
    expect(fetchOcspMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ responderURL: 'https://b.example.com' }),
    );
  });

  it('answers Failed when every OCSP responder fails (M07.FR.02)', async () => {
    fetchOcspMock.mockRejectedValue(new Error('unreachable'));
    const [entry] = await getCertificateChainStatus(
      [{ source: 'OCSP', urls: ['https://a.example.com'], certificateHashData: certId() }],
      logger,
    );
    expect(entry?.status).toBe('Failed');
  });

  it('answers certificates of the local contract CA from its records', async () => {
    localStatusMock.mockResolvedValueOnce('good').mockResolvedValueOnce('revoked');
    const hash = certId();
    const result = await getCertificateChainStatus(
      [
        { source: 'OCSP', urls: ['https://a.example.com'], certificateHashData: hash },
        { source: 'CRL', urls: ['https://c.example.com'], certificateHashData: hash },
      ],
      logger,
    );
    expect(result.map((r) => r.status)).toEqual(['Good', 'Revoked']);
    expect(fetchOcspMock).not.toHaveBeenCalled();
    expect(safeFetchMock).not.toHaveBeenCalled();
    // nextUpdate is required and at most one week out.
    for (const r of result) {
      const next = Date.parse(r.nextUpdate);
      expect(next).toBeGreaterThan(Date.now());
      expect(next).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
    }
  });
});
