// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
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
    expect(description).toHaveLength(14);
    expect(description[0]).toMatchObject({ schema: 2, role: 'moRoot' });
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
