// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import { describe, it, expect, beforeAll } from 'vitest';
import crypto, { webcrypto, X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import {
  createRootCertificate,
  issueCertificate,
  invalidServerCertificates,
  signCertificateRequest,
  certificateHashDataOf,
  sameHashData,
  signData,
  type TestCertificate,
} from '../cs-security-pki.js';

const EC = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

let root: TestCertificate;

beforeAll(async () => {
  root = await createRootCertificate('OCTT PKI Test Root');
});

async function csrPem(subject: string): Promise<string> {
  const keys = (await webcrypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: subject,
    keys,
    signingAlgorithm: EC,
  });
  return csr.toString('pem');
}

describe('cs-security-pki', () => {
  it('creates a self-signed CA root', () => {
    const cert = new X509Certificate(root.pem);
    expect(cert.ca).toBe(true);
    expect(cert.subject).toContain('CN=OCTT PKI Test Root');
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(root.issuer).toBeNull();
    expect(root.keyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('issues a leaf with SANs and extended key usage, signed by the issuer', async () => {
    const leaf = await issueCertificate({
      subject: 'CN=localhost',
      issuer: root,
      dnsNames: ['localhost'],
      ipAddresses: ['127.0.0.1'],
      extendedKeyUsages: ['1.3.6.1.5.5.7.3.1'],
    });
    const cert = new X509Certificate(leaf.pem);
    expect(cert.ca).toBe(false);
    expect(cert.checkHost('localhost')).toBe('localhost');
    expect(cert.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
    expect(cert.verify(new X509Certificate(root.pem).publicKey)).toBe(true);
    expect(leaf.issuer).toBe(root);
  });

  it('can issue a certificate for a given public key', async () => {
    const other = await issueCertificate({ subject: 'CN=other', issuer: root });
    const leaf = await issueCertificate({
      subject: 'CN=reuse',
      issuer: root,
      publicKey: other.keys.publicKey,
    });
    const a = new X509Certificate(leaf.pem).publicKey.export({ format: 'der', type: 'spki' });
    const b = new X509Certificate(other.pem).publicKey.export({ format: 'der', type: 'spki' });
    expect(a.equals(b)).toBe(true);
  });

  it('builds the five invalid server certificates of TC_078 / TC_A_05', async () => {
    const list = await invalidServerCertificates(root);
    expect(list.map((c) => c.name)).toEqual([
      'Expired',
      'Future validity date',
      'Not signed by installed Central System Root certificate',
      'CommonName that does not equal the FQDN of the server',
      'CommonName containing a wildcard hostname matching the FQDN',
    ]);
    const rootKey = new X509Certificate(root.pem).publicKey;
    const [expired, future, foreign, otherCn, wildcard] = list.map(
      (c) => new X509Certificate(c.cert.pem),
    );
    expect(Date.parse(expired?.validTo ?? '')).toBeLessThan(Date.now());
    expect(Date.parse(future?.validFrom ?? '')).toBeGreaterThan(Date.now());
    expect(foreign?.verify(rootKey)).toBe(false);
    expect(otherCn?.subject).toContain('CN=octt-other-host.example');
    expect(otherCn?.checkHost('localhost')).toBeUndefined();
    expect(wildcard?.subject).toContain('CN=*.localhost');
  });

  it('signs a valid CSR with client auth and keeps its subject', async () => {
    const signed = await signCertificateRequest(await csrPem('CN=SN-1,O=Vendor'), root);
    expect(signed.subject).toBe('CN=SN-1, O=Vendor');
    const cert = new X509Certificate(signed.chainPem);
    expect(cert.subject).toContain('CN=SN-1');
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.2');
    expect(cert.verify(new X509Certificate(root.pem).publicKey)).toBe(true);
  });

  it('refuses a CSR with a broken signature', async () => {
    const pem = await csrPem('CN=SN-2');
    const csr = new x509.Pkcs10CertificateRequest(pem);
    const raw = Buffer.from(csr.rawData);
    // Flip a bit near the end: inside the signature value.
    raw[raw.length - 5] = (raw[raw.length - 5] ?? 0) ^ 0x01;
    const tampered = new x509.Pkcs10CertificateRequest(raw).toString('pem');
    await expect(signCertificateRequest(tampered, root)).rejects.toThrow(
      'CSR signature is not valid',
    );
  });

  it('computes certificate hash data like OCSP CertID', async () => {
    const leaf = await issueCertificate({ subject: 'CN=leaf', issuer: root });
    const data = certificateHashDataOf(leaf.cert, root.cert);
    expect(data.hashAlgorithm).toBe('SHA256');
    expect(data.issuerNameHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.issuerKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.serialNumber).toBe(leaf.cert.serialNumber.toLowerCase().replace(/^0+/, ''));
    // The issuer name hash is the hash of the issuer's subject DER.
    const rootSubjectHash = crypto
      .createHash('sha256')
      .update(Buffer.from(root.cert.subjectName.toArrayBuffer()))
      .digest('hex');
    expect(data.issuerNameHash).toBe(rootSubjectHash);
    // A root is its own issuer.
    const self = certificateHashDataOf(root.cert, root.cert, 'SHA384');
    expect(self.issuerNameHash).toHaveLength(96);
    expect(self.issuerKeyHash).toBe(
      certificateHashDataOf(leaf.cert, root.cert, 'SHA384').issuerKeyHash,
    );
    expect(certificateHashDataOf(leaf.cert, root.cert, 'SHA512').issuerKeyHash).toHaveLength(128);
  });

  it('sameHashData compares case- and leading-zero-insensitively', () => {
    const a = {
      hashAlgorithm: 'SHA256',
      issuerNameHash: 'ABCD',
      issuerKeyHash: 'ef01',
      serialNumber: '00a1',
    };
    expect(
      sameHashData(a, { ...a, issuerNameHash: 'abcd', issuerKeyHash: 'EF01', serialNumber: 'A1' }),
    ).toBe(true);
    expect(sameHashData(a, { ...a, hashAlgorithm: 'SHA384' })).toBe(false);
    expect(sameHashData(a, { ...a, serialNumber: 'a2' })).toBe(false);
    expect(sameHashData({ ...a, serialNumber: '000' }, { ...a, serialNumber: '0' })).toBe(true);
    expect(sameHashData({ ...a, issuerKeyHash: 5 }, { ...a, issuerKeyHash: '' })).toBe(true);
  });

  it('signData makes an ECDSA SHA-256 signature the certificate verifies', () => {
    const data = Buffer.from('firmware image');
    const sig = signData(data, root);
    const pub = new X509Certificate(root.pem).publicKey;
    expect(crypto.verify('sha256', data, pub, Buffer.from(sig, 'base64'))).toBe(true);
    expect(crypto.verify('sha256', Buffer.from('other'), pub, Buffer.from(sig, 'base64'))).toBe(
      false,
    );
  });
});
