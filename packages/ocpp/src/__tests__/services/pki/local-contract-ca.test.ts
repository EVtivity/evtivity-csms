// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import {
  addCpoSubCas,
  hasCpoSubCas,
  issueSeccCertificate,
  createLocalContractCa,
  describeLocalContractCa,
  hierarchyFor,
  issueContractCertificate,
  parseLocalContractCa,
  type LocalContractCa,
} from '../../../services/pki/local-contract-ca.js';

let ca: LocalContractCa;

beforeAll(async () => {
  ca = await createLocalContractCa();
}, 60_000);

function cert(pem: string): crypto.X509Certificate {
  return new crypto.X509Certificate(pem);
}

describe('createLocalContractCa', () => {
  it('builds both hierarchies on their curves with short names', () => {
    for (const [schema, curve] of [
      [2, 'prime256v1'],
      [20, 'secp521r1'],
    ] as const) {
      const h = hierarchyFor(ca, schema);
      expect(cert(h.moRoot.cert).publicKey.asymmetricKeyDetails?.namedCurve).toBe(curve);
      for (const entry of Object.values(h)) {
        expect(cert(entry.cert).issuer.replace(/\n/g, ',').length).toBeLessThanOrEqual(64);
      }
      // Chains: Sub-CA 2 -> Sub-CA 1 -> root, CPS leaf -> Sub-CA 2 -> Sub-CA 1 -> root.
      expect(cert(h.moSubCa2.cert).verify(cert(h.moSubCa1.cert).publicKey)).toBe(true);
      expect(cert(h.moSubCa1.cert).verify(cert(h.moRoot.cert).publicKey)).toBe(true);
      expect(cert(h.cpsLeaf.cert).verify(cert(h.cpsSubCa2.cert).publicKey)).toBe(true);
      expect(cert(h.cpsSubCa2.cert).verify(cert(h.cpsSubCa1.cert).publicKey)).toBe(true);
      expect(cert(h.cpsSubCa1.cert).verify(cert(h.cpsRoot.cert).publicKey)).toBe(true);
      expect(cert(h.cpsLeaf.cert).ca).toBe(false);
      // CPO chain under the V2G root: Sub-CA 2 -> Sub-CA 1 -> V2G root.
      expect(cert(h.cpoSubCa2?.cert ?? '').verify(cert(h.cpoSubCa1?.cert ?? '').publicKey)).toBe(
        true,
      );
      expect(cert(h.cpoSubCa1?.cert ?? '').verify(cert(h.cpsRoot.cert).publicKey)).toBe(true);
      expect(h.cpoSubCa2?.key).toBeDefined();
      expect(h.cpoSubCa1?.key).toBeUndefined();
      // Keys kept: roots, MO Sub-CA 2, CPS leaf.
      expect(h.moRoot.key).toBeDefined();
      expect(h.cpsRoot.key).toBeDefined();
      expect(h.moSubCa2.key).toBeDefined();
      expect(h.cpsLeaf.key).toBeDefined();
      expect(h.moSubCa1.key).toBeUndefined();
      expect(h.cpsSubCa1.key).toBeUndefined();
      expect(h.cpsSubCa2.key).toBeUndefined();
      // ISO 15118-2 certificates fit the 800 byte certificateType.
      if (schema === 2) {
        for (const entry of Object.values(h)) expect(cert(entry.cert).raw.length).toBeLessThan(800);
      }
    }
  });

  it('round-trips through JSON and rejects malformed bundles', () => {
    expect(parseLocalContractCa(JSON.stringify(ca))).toEqual(ca);
    expect(parseLocalContractCa('not json')).toBeNull();
    expect(parseLocalContractCa(JSON.stringify({ ...ca, version: 2 }))).toBeNull();
    const noKey = JSON.parse(JSON.stringify(ca)) as LocalContractCa;
    delete noKey.iso20.cpsLeaf.key;
    expect(parseLocalContractCa(JSON.stringify(noKey))).toBeNull();
  });

  it('describes every certificate without keys', () => {
    const description = describeLocalContractCa(ca);
    expect(description).toHaveLength(18);
    expect(description[0]).toMatchObject({ schema: 2, role: 'moRoot' });
    expect(description.filter((d) => d.role.startsWith('cpo'))).toHaveLength(4);
    expect(description[0]?.certificate).toContain('BEGIN CERTIFICATE');
    expect(JSON.stringify(description)).not.toContain('PRIVATE KEY');
  });
});

describe('issueContractCertificate', () => {
  it('issues CN = eMAID from MO Sub-CA 2 with an 8 byte SKI for ISO 15118-20', async () => {
    const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'secp521r1' });
    const issued = await issueContractCertificate(ca.iso20, 20, 'USEVTC00000001', keys.publicKey);
    const c = new crypto.X509Certificate(issued.certificate);
    expect(c.subject).toContain('CN=USEVTC00000001');
    expect(c.verify(cert(ca.iso20.moSubCa2.cert).publicKey)).toBe(true);
    expect(issued.keyId).toHaveLength(16);
    expect(issued.serialNumber).toBe(c.serialNumber.toLowerCase().replace(/^0+/, ''));
    expect(issued.validTo.getTime()).toBeGreaterThan(Date.now());
  });

  it('issues a SHA-1 key identifier for ISO 15118-2', async () => {
    const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const issued = await issueContractCertificate(ca.iso2, 2, 'USEVTC00000002', keys.publicKey);
    expect(issued.keyId).toHaveLength(40);
    expect(issued.certificate.length).toBeLessThan(800);
  });
});

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

async function csrPem(curve: 'P-256' | 'P-521'): Promise<string> {
  const alg = { name: 'ECDSA', namedCurve: curve, hash: curve === 'P-256' ? 'SHA-256' : 'SHA-512' };
  const keys = (await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=CS-V2G-1,O=EVtivity',
    keys,
    signingAlgorithm: alg,
  });
  return csr.toString('pem');
}

describe('CPO Sub-CAs and station V2G certificates', () => {
  it('adds the CPO Sub-CAs to a CA created without them, under the same V2G root', async () => {
    const old = JSON.parse(JSON.stringify(ca)) as LocalContractCa;
    for (const h of [old.iso2, old.iso20]) {
      delete h.cpoSubCa1;
      delete h.cpoSubCa2;
    }
    expect(hasCpoSubCas(old)).toBe(false);
    expect(parseLocalContractCa(JSON.stringify(old))).not.toBeNull();
    const next = await addCpoSubCas(old);
    expect(hasCpoSubCas(next)).toBe(true);
    for (const schema of [2, 20] as const) {
      const h = hierarchyFor(next, schema);
      expect(h.cpsRoot.cert).toBe(hierarchyFor(old, schema).cpsRoot.cert);
      expect(cert(h.cpoSubCa1?.cert ?? '').verify(cert(h.cpsRoot.cert).publicKey)).toBe(true);
    }
    expect(await addCpoSubCas(next)).toBe(next);
  }, 30_000);

  it('signs a station CSR into a chain that ends at the V2G root', async () => {
    for (const [schema, curve] of [
      [2, 'P-256'],
      [20, 'P-521'],
    ] as const) {
      const h = hierarchyFor(ca, schema);
      const issued = await issueSeccCertificate(h, schema, await csrPem(curve));
      const chain = issued.certificateChain
        .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
        ?.map((pem) => cert(pem));
      expect(chain).toHaveLength(3);
      const [leaf, sub2, sub1] = chain as [
        crypto.X509Certificate,
        crypto.X509Certificate,
        crypto.X509Certificate,
      ];
      expect(leaf.subject).toContain('CN=CS-V2G-1');
      expect(leaf.ca).toBe(false);
      expect(leaf.verify(sub2.publicKey)).toBe(true);
      expect(sub2.verify(sub1.publicKey)).toBe(true);
      expect(sub1.verify(cert(h.cpsRoot.cert).publicKey)).toBe(true);
      expect(issued.serialNumber).toBe(leaf.serialNumber.toLowerCase().replace(/^0+/, ''));
    }
  }, 30_000);

  it('refuses a CSR whose signature does not verify', async () => {
    const pem = await csrPem('P-256');
    const der = Buffer.from(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
    der[der.length - 5] = (der[der.length - 5] ?? 0) ^ 0xff;
    await expect(
      issueSeccCertificate(
        hierarchyFor(ca, 2),
        2,
        `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64')}\n-----END CERTIFICATE REQUEST-----`,
      ),
    ).rejects.toThrow();
  });
});
