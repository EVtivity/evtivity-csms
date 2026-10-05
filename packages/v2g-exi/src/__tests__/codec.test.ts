// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeMessage,
  encodeMessage,
  encodeSigned,
  ExiCodecError,
  ISO2_SIGNATURE,
  ISO20_SIGNATURE,
  verifySignature,
  type DecodedIso20Message,
  type Iso2CertificateRes,
  type Iso20CertificateInstallationReq,
  type Iso20CertificateInstallationRes,
} from '../index.js';

const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const p521 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-521' });
const cert = (n: number): Buffer => Buffer.alloc(500, n);
const ROOTS = [{ issuerName: 'CN=V2G Root', serialNumber: '01' }];

describe('ISO 15118-2', () => {
  it('round-trips a signed CertificateInstallationReq and verifies its signature', () => {
    const encoded = encodeSigned(
      {
        schema: 2,
        sessionId: '0102030405060708',
        body: {
          type: 'CertificateInstallationReq',
          id: 'id1',
          oemProvisioningCert: cert(1),
          rootCertificateIds: [{ issuerName: 'CN=V2G Root', serialNumber: '0a1b' }],
        },
      },
      ['id1'],
      ISO2_SIGNATURE,
      p256.privateKey,
    );
    const decoded = decodeMessage(2, encoded.exi);
    expect(decoded.schema).toBe(2);
    expect(decoded.sessionId).toBe('0102030405060708');
    expect(decoded.body).toEqual({
      type: 'CertificateInstallationReq',
      id: 'id1',
      oemProvisioningCert: cert(1),
      rootCertificateIds: [{ issuerName: 'CN=V2G Root', serialNumber: '0a1b' }],
    });
    expect(decoded.signature?.references).toHaveLength(1);
    expect(verifySignature(decoded, ['id1'], ISO2_SIGNATURE, p256.publicKey)).toEqual({
      valid: true,
    });
    expect(verifySignature(decoded, ['id1'], ISO2_SIGNATURE, p521.publicKey)).toEqual({
      valid: false,
      reason: 'signature',
    });
  });

  it('round-trips a CertificateUpdateReq', () => {
    const encoded = encodeSigned(
      {
        schema: 2,
        sessionId: 'aabb',
        body: {
          type: 'CertificateUpdateReq',
          id: 'req',
          contractChain: { id: 'chain', certificate: cert(2), subCertificates: [cert(3)] },
          emaid: 'DEABCC12345678',
          rootCertificateIds: [{ issuerName: 'CN=MO Root', serialNumber: '01' }],
        },
      },
      ['req'],
      ISO2_SIGNATURE,
      p256.privateKey,
    );
    const decoded = decodeMessage(2, encoded.exi);
    expect(decoded.body.type).toBe('CertificateUpdateReq');
    expect(decoded.body).toMatchObject({ emaid: 'DEABCC12345678', id: 'req' });
    expect(verifySignature(decoded, ['req'], ISO2_SIGNATURE, p256.publicKey).valid).toBe(true);
  });

  it('signs the four CertificateInstallationRes elements and detects a tampered digest', () => {
    const body: Iso2CertificateRes = {
      type: 'CertificateInstallationRes',
      responseCode: 0,
      saProvisioningChain: { certificate: cert(4), subCertificates: [cert(5), cert(6)] },
      contractChain: { id: 'id1', certificate: cert(7), subCertificates: [cert(8), cert(9)] },
      encryptedPrivateKey: { id: 'id2', value: Buffer.alloc(48, 1) },
      dhPublicKey: { id: 'id3', value: Buffer.alloc(65, 2) },
      emaid: { id: 'id4', value: 'DEABCC12345678' },
    };
    const ids = ['id1', 'id2', 'id3', 'id4'];
    const encoded = encodeSigned(
      { schema: 2, sessionId: '0102030405060708', body },
      ids,
      ISO2_SIGNATURE,
      p256.privateKey,
    );
    const decoded = decodeMessage(2, encoded.exi);
    expect(decoded.body).toEqual(body);
    expect(Object.keys(decoded.fragments).sort()).toEqual(ids);
    expect(verifySignature(decoded, ids, ISO2_SIGNATURE, p256.publicKey).valid).toBe(true);

    const reEncoded = encodeMessage({
      schema: 2,
      sessionId: '0102030405060708',
      body: { ...body, emaid: { id: 'id4', value: 'DEABCC00000000' } },
      ...(decoded.signature != null
        ? {
            signature: {
              signatureMethod: decoded.signature.signatureMethod,
              digestMethod: ISO2_SIGNATURE.digestMethod,
              references: decoded.signature.references.map((r) => ({
                uri: r.uri ?? '',
                digestValue: r.digestValue,
              })),
              signatureValue: decoded.signature.signatureValue,
            },
          }
        : {}),
    });
    const tampered = decodeMessage(2, reEncoded.exi);
    expect(verifySignature(tampered, ids, ISO2_SIGNATURE, p256.publicKey)).toEqual({
      valid: false,
      reason: 'digest',
    });
  });

  it('reports an unsigned message and a missing reference', () => {
    const plain = encodeMessage({
      schema: 2,
      sessionId: '01',
      body: {
        type: 'CertificateInstallationReq',
        id: 'id1',
        oemProvisioningCert: cert(1),
        rootCertificateIds: ROOTS,
      },
    });
    const decoded = decodeMessage(2, plain.exi);
    expect(plain.signedInfo).toBeNull();
    expect(verifySignature(decoded, ['id1'], ISO2_SIGNATURE, p256.publicKey)).toEqual({
      valid: false,
      reason: 'missing',
    });
  });

  it('throws ExiCodecError for bytes that are not an EXI document', () => {
    expect(() => decodeMessage(2, Buffer.from('not exi'))).toThrow(ExiCodecError);
  });

  it('rejects a message without the root certificate IDs the schema requires', () => {
    expect(() =>
      encodeMessage({
        schema: 2,
        sessionId: '01',
        body: {
          type: 'CertificateInstallationReq',
          id: 'id1',
          oemProvisioningCert: cert(1),
          rootCertificateIds: [],
        },
      }),
    ).toThrow(ExiCodecError);
  });

  it('rejects a certificate larger than the schema allows', () => {
    expect(() =>
      encodeMessage({
        schema: 2,
        sessionId: '01',
        body: {
          type: 'CertificateInstallationReq',
          id: 'id1',
          oemProvisioningCert: Buffer.alloc(801),
          rootCertificateIds: ROOTS,
        },
      }),
    ).toThrow(ExiCodecError);
  });
});

describe('ISO 15118-20', () => {
  it('round-trips a signed CertificateInstallationReq over its OEM provisioning chain', () => {
    const body: Iso20CertificateInstallationReq = {
      type: 'CertificateInstallationReq',
      oemProvisioningChain: { id: 'id1', certificate: cert(1), subCertificates: [cert(2)] },
      rootCertificateIds: [{ issuerName: 'CN=V2G Root', serialNumber: '01' }],
      maximumContractCertificateChains: 10,
      prioritizedEmaids: ['DEABCC12345678', 'DEABCC87654321'],
    };
    const encoded = encodeSigned(
      { schema: 20, sessionId: '0102030405060708', timestamp: 1759600000n, body },
      ['id1'],
      ISO20_SIGNATURE,
      p521.privateKey,
    );
    const decoded = decodeMessage(20, encoded.exi) as DecodedIso20Message;
    expect(decoded.timestamp).toBe(1759600000n);
    expect(decoded.body).toEqual(body);
    expect(verifySignature(decoded, ['id1'], ISO20_SIGNATURE, p521.publicKey).valid).toBe(true);
    expect(verifySignature(decoded, ['id1'], ISO2_SIGNATURE, p521.publicKey)).toEqual({
      valid: false,
      reason: 'algorithm',
    });
  });

  it('round-trips a signed CertificateInstallationRes', () => {
    const body: Iso20CertificateInstallationRes = {
      type: 'CertificateInstallationRes',
      responseCode: 0,
      evseProcessing: 0,
      cpsChain: { certificate: cert(3), subCertificates: [cert(4), cert(5)] },
      signedInstallationData: {
        id: 'id1',
        contractChain: { certificate: cert(6), subCertificates: [cert(7), cert(8)] },
        ecdhCurve: 0,
        dhPublicKey: Buffer.alloc(133, 4),
        encryptedPrivateKey: { kind: 'SECP521', value: Buffer.alloc(94, 5) },
      },
      remainingContractCertificateChains: 2,
    };
    const encoded = encodeSigned(
      { schema: 20, sessionId: '0102030405060708', timestamp: 1n, body },
      ['id1'],
      ISO20_SIGNATURE,
      p521.privateKey,
    );
    const decoded = decodeMessage(20, encoded.exi);
    expect(decoded.body).toEqual(body);
    expect(verifySignature(decoded, ['id1'], ISO20_SIGNATURE, p521.publicKey).valid).toBe(true);
  });

  it('decodes an ISO 15118-2 document with the -20 grammar as an error, not garbage', () => {
    const iso2 = encodeMessage({
      schema: 2,
      sessionId: '01',
      body: {
        type: 'CertificateInstallationReq',
        id: 'id1',
        oemProvisioningCert: cert(1),
        rootCertificateIds: ROOTS,
      },
    });
    expect(() => decodeMessage(20, iso2.exi)).toThrow(ExiCodecError);
  });
});
