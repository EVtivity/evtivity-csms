// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ISO 15118 header signatures: XML signature over EXI (ISO 15118-2 Annex J,
// ISO 15118-20 8.x). Each Reference holds the digest of the EXI fragment
// encoding of the referenced element; the signature covers the EXI encoding
// of SignedInfo and is the raw r || s ECDSA value.

import crypto, { type KeyObject } from 'node:crypto';
import {
  encodeMessage,
  XmlDsig,
  type DecodedMessage,
  type EncodeInput,
  type EncodeResult,
} from './messages.js';

export interface SignatureProfile {
  signatureMethod: string;
  digestMethod: string;
  hash: 'sha256' | 'sha512';
}

/** ISO 15118-2: ECDSA secp256r1 with SHA-256. */
export const ISO2_SIGNATURE: SignatureProfile = {
  signatureMethod: XmlDsig.ECDSA_SHA256,
  digestMethod: XmlDsig.SHA256,
  hash: 'sha256',
};

/** ISO 15118-20 default algorithm: ECDSA secp521r1 with SHA-512. */
export const ISO20_SIGNATURE: SignatureProfile = {
  signatureMethod: XmlDsig.ECDSA_SHA512,
  digestMethod: XmlDsig.SHA512,
  hash: 'sha512',
};

function digest(hash: 'sha256' | 'sha512', data: Uint8Array): Buffer {
  return crypto.createHash(hash).update(data).digest();
}

/**
 * Encodes a message with a header signature over the elements `signedIds`
 * (their Id attributes), signed with `privateKey`.
 */
export function encodeSigned(
  input: EncodeInput,
  signedIds: string[],
  profile: SignatureProfile,
  privateKey: KeyObject,
): EncodeResult {
  const rest: EncodeInput = { ...input };
  delete rest.signature;
  const unsigned = encodeMessage(rest);
  const references = signedIds.map((id) => {
    const fragment = unsigned.decoded.fragments[id];
    if (fragment == null) throw new Error(`No signable element with Id ${id}`);
    return { uri: `#${id}`, digestValue: digest(profile.hash, fragment) };
  });
  const base = {
    signatureMethod: profile.signatureMethod,
    digestMethod: profile.digestMethod,
    references,
  };
  const draft = encodeMessage({
    ...rest,
    signature: { ...base, signatureValue: new Uint8Array(0) },
  });
  if (draft.signedInfo == null) throw new Error('SignedInfo was not encoded');
  const signatureValue = crypto.sign(profile.hash, draft.signedInfo, {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return encodeMessage({ ...rest, signature: { ...base, signatureValue } });
}

export type SignatureCheck =
  | { valid: true }
  | { valid: false; reason: 'missing' | 'algorithm' | 'reference' | 'digest' | 'signature' };

/**
 * Verifies the header signature of a decoded message: the algorithms match
 * the profile, every element in `requiredIds` is referenced with a correct
 * digest, no reference points elsewhere, and the signature over SignedInfo
 * verifies with `publicKey`.
 */
export function verifySignature(
  message: DecodedMessage,
  requiredIds: string[],
  profile: SignatureProfile,
  publicKey: KeyObject,
): SignatureCheck {
  const sig = message.signature;
  if (sig == null) return { valid: false, reason: 'missing' };
  if (
    sig.signatureMethod !== profile.signatureMethod ||
    sig.canonicalizationMethod !== XmlDsig.CANONICAL_EXI
  ) {
    return { valid: false, reason: 'algorithm' };
  }
  const referenced = new Set<string>();
  for (const ref of sig.references) {
    if (ref.digestMethod !== profile.digestMethod) return { valid: false, reason: 'algorithm' };
    if (ref.uri == null || !ref.uri.startsWith('#')) return { valid: false, reason: 'reference' };
    const fragment = message.fragments[ref.uri.slice(1)];
    if (fragment == null) return { valid: false, reason: 'reference' };
    if (!digest(profile.hash, fragment).equals(ref.digestValue)) {
      return { valid: false, reason: 'digest' };
    }
    referenced.add(ref.uri.slice(1));
  }
  if (requiredIds.some((id) => !referenced.has(id))) return { valid: false, reason: 'reference' };
  let ok = false;
  try {
    ok = crypto.verify(
      profile.hash,
      sig.signedInfo,
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      sig.signatureValue,
    );
  } catch {
    ok = false;
  }
  return ok ? { valid: true } : { valid: false, reason: 'signature' };
}
