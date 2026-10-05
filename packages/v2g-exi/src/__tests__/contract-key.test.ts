// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  concatKdf,
  decryptContractKeyIso2,
  decryptContractKeyIso20,
  encryptContractKeyIso2,
  encryptContractKeyIso20,
  iso20Aad,
  privateKeyFromScalar,
  privateScalar,
  publicKeyFromPoint,
  uncompressedPoint,
} from '../index.js';

function sameKey(a: crypto.KeyObject, b: crypto.KeyObject): boolean {
  return privateScalar(a).equals(privateScalar(b));
}

describe('concatKdf', () => {
  it('hashes counter 1, the shared secret and OtherInfo 01 55 56', () => {
    const z = Buffer.alloc(32, 7);
    const expected = crypto
      .createHash('sha256')
      .update(Buffer.concat([Buffer.from([0, 0, 0, 1]), z, Buffer.from([1, 0x55, 0x56])]))
      .digest()
      .subarray(0, 16);
    expect(concatKdf('sha256', z, 16).equals(expected)).toBe(true);
    expect(concatKdf('sha512', z, 32)).toHaveLength(32);
  });
});

describe('ISO 15118-2 key transport', () => {
  it('lets the recipient recover the contract key', () => {
    const oem = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const contract = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sent = encryptContractKeyIso2(oem.publicKey, contract.privateKey);
    expect(sent.dhPublicKey).toHaveLength(65);
    expect(sent.dhPublicKey[0]).toBe(4);
    expect(sent.encryptedPrivateKey).toHaveLength(48);
    const recovered = decryptContractKeyIso2(
      oem.privateKey,
      sent.dhPublicKey,
      sent.encryptedPrivateKey,
    );
    expect(sameKey(recovered, contract.privateKey)).toBe(true);
  });

  it('gives another key to a different recipient', () => {
    const oem = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const contract = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sent = encryptContractKeyIso2(oem.publicKey, contract.privateKey);
    let recovered: crypto.KeyObject | null = null;
    try {
      recovered = decryptContractKeyIso2(
        other.privateKey,
        sent.dhPublicKey,
        sent.encryptedPrivateKey,
      );
    } catch {
      recovered = null;
    }
    expect(recovered == null || !sameKey(recovered, contract.privateKey)).toBe(true);
  });
});

describe('ISO 15118-20 key transport', () => {
  const aad = iso20Aad('WMIV1234567890ABCD', '0102030405060708');

  it('builds the AAD from the PCID and the upper case SKI', () => {
    expect(aad.toString('ascii')).toBe('WMIV1234567890ABCD0102030405060708');
    expect(iso20Aad('wmi-v12', 'abcd').toString('ascii')).toBe('WMIV12ABCD');
  });

  it('lets the recipient recover the contract key and rejects another AAD', () => {
    const oem = crypto.generateKeyPairSync('ec', { namedCurve: 'secp521r1' });
    const contract = crypto.generateKeyPairSync('ec', { namedCurve: 'secp521r1' });
    const sent = encryptContractKeyIso20(oem.publicKey, contract.privateKey, aad);
    expect(sent.dhPublicKey).toHaveLength(133);
    expect(sent.encryptedPrivateKey).toHaveLength(94);
    const recovered = decryptContractKeyIso20(
      oem.privateKey,
      sent.dhPublicKey,
      sent.encryptedPrivateKey,
      aad,
    );
    expect(sameKey(recovered, contract.privateKey)).toBe(true);
    expect(() =>
      decryptContractKeyIso20(
        oem.privateKey,
        sent.dhPublicKey,
        sent.encryptedPrivateKey,
        iso20Aad('OTHERPCID000000000', '0102030405060708'),
      ),
    ).toThrow();
    expect(() =>
      decryptContractKeyIso20(oem.privateKey, sent.dhPublicKey, Buffer.alloc(10), aad),
    ).toThrow('length');
  });
});

describe('point and scalar helpers', () => {
  it('round-trips public points with and without the 0x04 prefix', () => {
    const key = crypto.generateKeyPairSync('ec', { namedCurve: 'secp521r1' });
    const point = uncompressedPoint(key.publicKey);
    const fromFull = publicKeyFromPoint('P-521', point);
    const fromXy = publicKeyFromPoint('P-521', point.subarray(1));
    expect(uncompressedPoint(fromFull).equals(point)).toBe(true);
    expect(uncompressedPoint(fromXy).equals(point)).toBe(true);
    expect(() => publicKeyFromPoint('P-256', point)).toThrow('length');
  });

  it('rebuilds a private key from its scalar', () => {
    const key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const rebuilt = privateKeyFromScalar('P-256', privateScalar(key.privateKey));
    expect(sameKey(rebuilt, key.privateKey)).toBe(true);
  });
});
