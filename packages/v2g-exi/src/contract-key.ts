// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Contract certificate private key transport (ECDHE + NIST SP 800-56A
// concatenation KDF, sender party U = 0x55, receiver party V = 0x56,
// algorithm ID 0x01):
//
//   ISO 15118-2:  secp256r1, KDF with SHA-256 to a 128-bit key, AES-128-CBC
//                 without padding, IV (16 bytes) || ciphertext (32 bytes).
//   ISO 15118-20: secp521r1, KDF with SHA-512 to a 256-bit key, AES-256-GCM
//                 with AAD = PCID || SKI of the contract certificate (upper
//                 case hex), IV (12) || ciphertext (66) || tag (16).
//
// The DH public key is the uncompressed point of the sender's ephemeral key.

import crypto, { type KeyObject } from 'node:crypto';

const OTHER_INFO = Buffer.from([0x01, 0x55, 0x56]);

type Curve = 'P-256' | 'P-521';

const CURVE_BYTES: Record<Curve, number> = { 'P-256': 32, 'P-521': 66 };
const ECDH_NAME: Record<Curve, string> = { 'P-256': 'prime256v1', 'P-521': 'secp521r1' };

/** NIST SP 800-56A concatenation KDF for an output no longer than one hash block. */
export function concatKdf(hash: 'sha256' | 'sha512', z: Buffer, keyLength: number): Buffer {
  return crypto
    .createHash(hash)
    .update(Buffer.from([0, 0, 0, 1]))
    .update(z)
    .update(OTHER_INFO)
    .digest()
    .subarray(0, keyLength);
}

function b64url(value: string | undefined): Buffer {
  return Buffer.from(value ?? '', 'base64url');
}

function leftPad(bytes: Buffer, length: number): Buffer {
  if (bytes.length >= length) return bytes.subarray(bytes.length - length);
  return Buffer.concat([Buffer.alloc(length - bytes.length), bytes]);
}

function curveOf(key: KeyObject): Curve {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.crv === 'P-256' || jwk.crv === 'P-521') return jwk.crv;
  throw new Error(`Unsupported curve ${String(jwk.crv)}`);
}

/** Uncompressed point (0x04 || X || Y) of an EC key. */
export function uncompressedPoint(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  const size = CURVE_BYTES[curveOf(key)];
  return Buffer.concat([
    Buffer.from([4]),
    leftPad(b64url(jwk.x), size),
    leftPad(b64url(jwk.y), size),
  ]);
}

/** EC public key from an uncompressed point. */
export function publicKeyFromPoint(curve: Curve, point: Uint8Array): KeyObject {
  const size = CURVE_BYTES[curve];
  const bytes = Buffer.from(point);
  // ISO 15118-20 lets the receiver read the least significant bytes, so a
  // point with or without the 0x04 prefix is accepted.
  const xy = bytes.length === size * 2 + 1 ? bytes.subarray(1) : bytes;
  if (xy.length !== size * 2) throw new Error('Invalid EC point length');
  return crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: curve,
      x: xy.subarray(0, size).toString('base64url'),
      y: xy.subarray(size).toString('base64url'),
    },
    format: 'jwk',
  });
}

/** Private scalar of an EC key, big-endian, padded to the curve size. */
export function privateScalar(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  return leftPad(b64url(jwk.d), CURVE_BYTES[curveOf(key)]);
}

/** EC private key from its scalar. */
export function privateKeyFromScalar(curve: Curve, scalar: Uint8Array): KeyObject {
  const ecdh = crypto.createECDH(ECDH_NAME[curve]);
  ecdh.setPrivateKey(Buffer.from(scalar));
  const point = ecdh.getPublicKey();
  const size = CURVE_BYTES[curve];
  return crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: curve,
      d: Buffer.from(scalar).toString('base64url'),
      x: point.subarray(1, 1 + size).toString('base64url'),
      y: point.subarray(1 + size).toString('base64url'),
    },
    format: 'jwk',
  });
}

export interface EncryptedContractKey {
  /** Uncompressed point of the sender's ephemeral ECDH key. */
  dhPublicKey: Buffer;
  encryptedPrivateKey: Buffer;
}

/**
 * ISO 15118-2: encrypts the contract private key for the holder of
 * `recipientPublicKey` (the OEM provisioning certificate key on
 * installation, the current contract certificate key on update).
 */
export function encryptContractKeyIso2(
  recipientPublicKey: KeyObject,
  contractPrivateKey: KeyObject,
): EncryptedContractKey {
  const ephemeral = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const z = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPublicKey,
  });
  const key = concatKdf('sha256', z, 16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv).setAutoPadding(false);
  const ciphertext = Buffer.concat([
    cipher.update(privateScalar(contractPrivateKey)),
    cipher.final(),
  ]);
  return {
    dhPublicKey: uncompressedPoint(ephemeral.publicKey),
    encryptedPrivateKey: Buffer.concat([iv, ciphertext]),
  };
}

/** ISO 15118-2: the EV side of encryptContractKeyIso2. */
export function decryptContractKeyIso2(
  recipientPrivateKey: KeyObject,
  dhPublicKey: Uint8Array,
  encryptedPrivateKey: Uint8Array,
): KeyObject {
  const z = crypto.diffieHellman({
    privateKey: recipientPrivateKey,
    publicKey: publicKeyFromPoint('P-256', dhPublicKey),
  });
  const key = concatKdf('sha256', z, 16);
  const data = Buffer.from(encryptedPrivateKey);
  const decipher = crypto
    .createDecipheriv('aes-128-cbc', key, data.subarray(0, 16))
    .setAutoPadding(false);
  const scalar = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
  return privateKeyFromScalar('P-256', scalar);
}

/** ISO 15118-20 AAD: PCID (upper case, no separators) followed by the contract certificate SKI as upper case hex. */
export function iso20Aad(pcid: string, contractSkiHex: string): Buffer {
  return Buffer.from(
    `${pcid.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}${contractSkiHex.toUpperCase()}`,
    'ascii',
  );
}

/** ISO 15118-20 SECP521: encrypts the contract private key for the OEM provisioning key holder. */
export function encryptContractKeyIso20(
  recipientPublicKey: KeyObject,
  contractPrivateKey: KeyObject,
  aad: Buffer,
): EncryptedContractKey {
  const ephemeral = crypto.generateKeyPairSync('ec', { namedCurve: 'secp521r1' });
  const z = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPublicKey,
  });
  const key = concatKdf('sha512', z, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(privateScalar(contractPrivateKey)),
    cipher.final(),
  ]);
  return {
    dhPublicKey: uncompressedPoint(ephemeral.publicKey),
    encryptedPrivateKey: Buffer.concat([iv, ciphertext, cipher.getAuthTag()]),
  };
}

/** ISO 15118-20 SECP521: the EV side of encryptContractKeyIso20. */
export function decryptContractKeyIso20(
  recipientPrivateKey: KeyObject,
  dhPublicKey: Uint8Array,
  encryptedPrivateKey: Uint8Array,
  aad: Buffer,
): KeyObject {
  const z = crypto.diffieHellman({
    privateKey: recipientPrivateKey,
    publicKey: publicKeyFromPoint('P-521', dhPublicKey),
  });
  const key = concatKdf('sha512', z, 32);
  const data = Buffer.from(encryptedPrivateKey);
  if (data.length !== 12 + 66 + 16) throw new Error('Invalid SECP521_EncryptedPrivateKey length');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(data.subarray(78));
  const scalar = Buffer.concat([decipher.update(data.subarray(12, 78)), decipher.final()]);
  return privateKeyFromScalar('P-521', scalar);
}
