// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// verifySignature on a decoded message whose signature block was altered:
// every check refuses with its own reason, and nothing throws.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeMessage,
  encodeSigned,
  ISO2_SIGNATURE,
  ISO20_SIGNATURE,
  verifySignature,
} from '../index.js';

const key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

function signed() {
  const encoded = encodeSigned(
    {
      schema: 2,
      sessionId: '0102030405060708',
      body: {
        type: 'CertificateInstallationReq',
        id: 'id1',
        oemProvisioningCert: Buffer.alloc(500, 1),
        rootCertificateIds: [{ issuerName: 'CN=V2G Root', serialNumber: '0a1b' }],
      },
    },
    ['id1'],
    ISO2_SIGNATURE,
    key.privateKey,
  );
  return decodeMessage(2, encoded.exi);
}

type Sig = NonNullable<ReturnType<typeof signed>['signature']>;

function withSignature(change: (sig: Sig) => Sig) {
  const message = signed();
  return { ...message, signature: change(message.signature as Sig) };
}

describe('encodeSigned', () => {
  it('refuses to sign an element id the message does not have', () => {
    expect(() =>
      encodeSigned(
        {
          schema: 2,
          sessionId: '0102030405060708',
          body: {
            type: 'CertificateInstallationReq',
            id: 'id1',
            oemProvisioningCert: Buffer.alloc(500, 1),
            rootCertificateIds: [{ issuerName: 'CN=V2G Root', serialNumber: '0a1b' }],
          },
        },
        ['nope'],
        ISO2_SIGNATURE,
        key.privateKey,
      ),
    ).toThrow(/No signable element with Id nope/);
  });
});

describe('verifySignature refusals', () => {
  it('refuses another profile and another canonicalization', () => {
    expect(verifySignature(signed(), ['id1'], ISO20_SIGNATURE, key.publicKey)).toEqual({
      valid: false,
      reason: 'algorithm',
    });
    const otherC14n = withSignature((s) => ({ ...s, canonicalizationMethod: 'urn:other' }));
    expect(verifySignature(otherC14n, ['id1'], ISO2_SIGNATURE, key.publicKey).valid).toBe(false);
  });

  it('refuses a reference with another digest method, a non-local URI or an unknown element', () => {
    const ref = (change: Record<string, unknown>) =>
      withSignature((s) => ({
        ...s,
        references: s.references.map((r) => ({ ...r, ...change })),
      }));
    expect(
      verifySignature(ref({ digestMethod: 'urn:md5' }), ['id1'], ISO2_SIGNATURE, key.publicKey),
    ).toEqual({ valid: false, reason: 'algorithm' });
    expect(
      verifySignature(ref({ uri: 'http://x/#id1' }), ['id1'], ISO2_SIGNATURE, key.publicKey),
    ).toEqual({ valid: false, reason: 'reference' });
    expect(
      verifySignature(ref({ uri: undefined }), ['id1'], ISO2_SIGNATURE, key.publicKey),
    ).toEqual({ valid: false, reason: 'reference' });
    expect(verifySignature(ref({ uri: '#other' }), ['id1'], ISO2_SIGNATURE, key.publicKey)).toEqual(
      {
        valid: false,
        reason: 'reference',
      },
    );
  });

  it('refuses when a required element is not referenced', () => {
    expect(verifySignature(signed(), ['id1', 'id2'], ISO2_SIGNATURE, key.publicKey)).toEqual({
      valid: false,
      reason: 'reference',
    });
  });

  it('answers signature for a malformed signature value instead of throwing', () => {
    const bad = withSignature((s) => ({ ...s, signatureValue: Buffer.alloc(3) }));
    expect(verifySignature(bad, ['id1'], ISO2_SIGNATURE, key.publicKey)).toEqual({
      valid: false,
      reason: 'signature',
    });
  });
});
