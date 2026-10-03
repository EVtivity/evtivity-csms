// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import * as x509 from '@peculiar/x509';
import {
  certificateHashData,
  certificateMatchesPrivateKey,
  chainsToTrustedRoot,
  generateKeyPairAndCsr,
  isCaCertificate,
  isSelfSigned,
  normalizeSerialNumber,
  parseCertificateChain,
  sameCertificateHashData,
  verifySignature,
} from '../lib/station-pki.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY = 24 * 60 * 60 * 1000;

async function keys(): Promise<CryptoKeyPair> {
  return (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
}

async function root(
  name = 'CN=Test Root',
): Promise<{ cert: x509.X509Certificate; keys: CryptoKeyPair }> {
  const k = await keys();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '00a1b2',
    name,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + DAY),
    keys: k,
    signingAlgorithm: ALG,
    extensions: caExtensions(),
  });
  return { cert, keys: k };
}

function caExtensions(
  opts: { ca?: boolean; keyCertSign?: boolean; pathLength?: number } = {},
): x509.Extension[] {
  return [
    new x509.BasicConstraintsExtension(opts.ca ?? true, opts.pathLength, true),
    new x509.KeyUsagesExtension(
      opts.keyCertSign === false
        ? x509.KeyUsageFlags.digitalSignature
        : x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
      true,
    ),
  ];
}

// An intermediate certificate with its own key pair, issued by `issuer`.
async function intermediate(
  issuer: { cert: x509.X509Certificate; keys: CryptoKeyPair },
  extensions: x509.Extension[],
  name = 'CN=Intermediate',
): Promise<{ cert: x509.X509Certificate; keys: CryptoKeyPair }> {
  const k = await keys();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: '0b',
    subject: name,
    issuer: issuer.cert.subject,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + DAY),
    publicKey: k.publicKey,
    signingKey: issuer.keys.privateKey,
    signingAlgorithm: ALG,
    extensions,
  });
  return { cert, keys: k };
}

async function leaf(
  issuer: { cert: x509.X509Certificate; keys: CryptoKeyPair },
  publicKey: CryptoKey,
  notAfter = new Date(Date.now() + DAY),
): Promise<x509.X509Certificate> {
  return x509.X509CertificateGenerator.create({
    serialNumber: '0c',
    subject: 'CN=Leaf',
    issuer: issuer.cert.subject,
    notBefore: new Date(Date.now() - 2 * DAY),
    notAfter,
    publicKey,
    signingKey: issuer.keys.privateKey,
    signingAlgorithm: ALG,
  });
}

function node(cert: x509.X509Certificate): crypto.X509Certificate {
  return new crypto.X509Certificate(cert.toString('pem'));
}

describe('station-pki', () => {
  it('computes certificate hash data from the issuer name and issuer public key', async () => {
    const r = await root();
    const cert = node(r.cert);
    const raw = Buffer.from(await webcrypto.subtle.exportKey('raw', r.keys.publicKey));

    const hash = certificateHashData(cert, cert);

    expect(hash.hashAlgorithm).toBe('SHA256');
    expect(hash.serialNumber).toBe('a1b2');
    expect(hash.issuerKeyHash).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
    expect(hash.issuerNameHash).toBe(
      crypto
        .createHash('sha256')
        .update(Buffer.from(r.cert.issuerName.toArrayBuffer()))
        .digest('hex'),
    );
    expect(certificateHashData(cert, cert, 'SHA512').issuerKeyHash).toHaveLength(128);
  });

  it('compares hash data case-insensitively and without serial leading zeroes', () => {
    const a = {
      hashAlgorithm: 'SHA256',
      issuerNameHash: 'AB',
      issuerKeyHash: 'cd',
      serialNumber: '0F',
    };
    const b = {
      hashAlgorithm: 'SHA256',
      issuerNameHash: 'ab',
      issuerKeyHash: 'CD',
      serialNumber: 'f',
    };
    expect(sameCertificateHashData(a, b)).toBe(true);
    expect(sameCertificateHashData(a, { ...b, hashAlgorithm: 'SHA384' })).toBe(false);
    expect(normalizeSerialNumber('000')).toBe('0');
  });

  it('accepts a chain to a trusted root and refuses untrusted or expired chains', async () => {
    const r = await root();
    const other = await root('CN=Other Root');
    const k = await keys();
    const valid = node(await leaf(r, k.publicKey));
    const expired = node(await leaf(r, k.publicKey, new Date(Date.now() - DAY)));

    expect(isSelfSigned(node(r.cert))).toBe(true);
    expect(isSelfSigned(valid)).toBe(false);
    expect(chainsToTrustedRoot([valid], [node(r.cert)])).toBe(true);
    expect(chainsToTrustedRoot([valid], [node(other.cert)])).toBe(false);
    expect(chainsToTrustedRoot([expired], [node(r.cert)])).toBe(false);
    expect(chainsToTrustedRoot([], [node(r.cert)])).toBe(false);
  });

  it('requires every issuer in the chain to be a CA with keyCertSign', async () => {
    const r = await root();
    const k = await keys();
    const notCa = await intermediate(r, caExtensions({ ca: false }), 'CN=Not CA');
    const noCertSign = await intermediate(r, caExtensions({ keyCertSign: false }), 'CN=No Sign');
    const goodCa = await intermediate(r, caExtensions(), 'CN=Good CA');

    for (const issuer of [notCa, noCertSign]) {
      const chain = [node(await leaf(issuer, k.publicKey)), node(issuer.cert)];
      expect(chainsToTrustedRoot(chain, [node(r.cert)])).toBe(false);
    }
    const good = [node(await leaf(goodCa, k.publicKey)), node(goodCa.cert)];
    expect(chainsToTrustedRoot(good, [node(r.cert)])).toBe(true);
    expect(isCaCertificate(node(goodCa.cert))).toBe(true);
    expect(isCaCertificate(node(notCa.cert))).toBe(false);
    expect(isCaCertificate(node(noCertSign.cert))).toBe(false);
  });

  it('refuses a trusted root that is not a CA', async () => {
    const k0 = await keys();
    const leafRoot = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '0d',
      name: 'CN=Leaf Root',
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + DAY),
      keys: k0,
      signingAlgorithm: ALG,
      extensions: caExtensions({ ca: false }),
    });
    const k = await keys();
    const chain = [node(await leaf({ cert: leafRoot, keys: k0 }, k.publicKey))];
    expect(chainsToTrustedRoot(chain, [node(leafRoot)])).toBe(false);
  });

  it('enforces pathLenConstraint', async () => {
    const strictRoot = await (async () => {
      const k = await keys();
      const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: '0e',
        name: 'CN=Strict Root',
        notBefore: new Date(Date.now() - DAY),
        notAfter: new Date(Date.now() + DAY),
        keys: k,
        signingAlgorithm: ALG,
        extensions: caExtensions({ pathLength: 0 }),
      });
      return { cert, keys: k };
    })();
    const k = await keys();
    // pathLen 0: the root may sign leaves, not intermediate CAs.
    expect(
      chainsToTrustedRoot([node(await leaf(strictRoot, k.publicKey))], [node(strictRoot.cert)]),
    ).toBe(true);
    const sub = await intermediate(strictRoot, caExtensions());
    const chain = [node(await leaf(sub, k.publicKey)), node(sub.cert)];
    expect(chainsToTrustedRoot(chain, [node(strictRoot.cert)])).toBe(false);

    // pathLen 0 on the intermediate: it may still sign the leaf.
    const r = await root();
    const sub0 = await intermediate(r, caExtensions({ pathLength: 0 }));
    const chain0 = [node(await leaf(sub0, k.publicKey)), node(sub0.cert)];
    expect(chainsToTrustedRoot(chain0, [node(r.cert)])).toBe(true);
  });

  it('parses PEM chains and rejects text without certificates', async () => {
    const r = await root();
    const pem = `${r.cert.toString('pem')}\n${r.cert.toString('pem')}`;
    expect(parseCertificateChain(pem)).toHaveLength(2);
    expect(parseCertificateChain('not a certificate')).toBeNull();
    expect(
      parseCertificateChain('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'),
    ).toBeNull();
  });

  it('scans many BEGIN lines without an END line in linear time', () => {
    const input = '-----BEGIN CERTIFICATE-----'.repeat(50_000);
    const started = performance.now();
    expect(parseCertificateChain(input)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('generates a CSR whose key matches the certificate issued for it', async () => {
    const { csrPem, privateKeyPem } = await generateKeyPairAndCsr({
      commonName: 'SN-1',
      organizationName: 'CPO, Inc',
    });
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    expect(await csr.verify()).toBe(true);
    expect(csr.subject).toContain('CN=SN-1');
    expect(csr.subject).toContain('O=CPO\\, Inc');

    const r = await root();
    const issued = node(await leaf(r, await csr.publicKey.export(ALG, ['verify'])));
    expect(certificateMatchesPrivateKey(issued, privateKeyPem)).toBe(true);
    const unrelated = node(await leaf(r, (await keys()).publicKey));
    expect(certificateMatchesPrivateKey(unrelated, privateKeyPem)).toBe(false);
  });

  it('verifies a base64 DER ECDSA SHA-256 signature', async () => {
    const r = await root();
    const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', r.keys.privateKey);
    const key = crypto.createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' });
    const data = Buffer.from('firmware image');
    const signature = crypto.sign('sha256', data, key).toString('base64');

    expect(verifySignature(data, signature, node(r.cert))).toBe(true);
    expect(verifySignature(Buffer.from('other image'), signature, node(r.cert))).toBe(false);
    expect(verifySignature(data, 'not-base64!', node(r.cert))).toBe(false);
  });
});
