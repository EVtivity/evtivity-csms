// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { X509Certificate, createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { decode as cborDecode } from 'cbor-x';
import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';

// Apple App Attest Root CA. Published at
// https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
// (CN=Apple App Attestation Root CA, valid through 2045-03-15).
const APPLE_APP_ATTEST_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

const NONCE_OID = '1.2.840.113635.100.8.2';

export interface AttestVerifyInput {
  teamId: string;
  bundleId: string;
  environment: 'development' | 'production';
}

export interface RegistrationResult {
  ok: boolean;
  publicKeyPem?: string;
  signCount?: number;
}

export interface AssertionResult {
  ok: boolean;
  newSignCount?: number;
}

function sha256(...buffers: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const b of buffers) h.update(b);
  return h.digest();
}

function appIdHash(teamId: string, bundleId: string): Buffer {
  return sha256(Buffer.from(`${teamId}.${bundleId}`));
}

// authData layout: rpIdHash(32) | flags(1) | signCount(4) | [aaguid(16) |
// credIdLen(2) | credId | coseKey] when the AT flag is set.
function parseAuthData(authData: Buffer): {
  rpIdHash: Buffer;
  signCount: number;
  credentialId: Buffer | undefined;
} {
  const rpIdHash = authData.subarray(0, 32);
  const signCount = authData.readUInt32BE(33);
  let credentialId: Buffer | undefined;
  if ((authData.readUInt8(32) & 0x40) !== 0 && authData.length >= 55) {
    const credIdLen = authData.readUInt16BE(53);
    credentialId = authData.subarray(55, 55 + credIdLen);
  }
  return { rpIdHash, signCount, credentialId };
}

function nonceExtension(cert: X509Certificate): Buffer | null {
  try {
    const asn = AsnConvert.parse(Buffer.from(cert.raw), Certificate);
    const ext = asn.tbsCertificate.extensions?.find((e) => e.extnID === NONCE_OID);
    if (ext == null) return null;
    // extnValue wraps a SEQUENCE { [1] EXPLICIT OCTET STRING nonce }. Locate the
    // inner 32-byte OCTET STRING.
    const raw = Buffer.from(ext.extnValue.buffer);
    for (let i = 0; i + 2 < raw.length; i++) {
      if (raw[i] === 0x04 && raw[i + 1] === 0x20) {
        return raw.subarray(i + 2, i + 2 + 32);
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Validates the one-time attestation produced by DCAppAttestService.attestKey.
export function verifyRegistration(
  attestationB64: string,
  keyId: string,
  challenge: string,
  cfg: AttestVerifyInput,
): RegistrationResult {
  try {
    const att = cborDecode(Buffer.from(attestationB64, 'base64')) as {
      fmt: string;
      attStmt: { x5c: Uint8Array[] };
      authData: Uint8Array;
    };
    if (att.fmt !== 'apple-appattest') return { ok: false };

    const [leafDer, intermediateDer] = att.attStmt.x5c.map((c) => Buffer.from(c));
    if (leafDer == null || intermediateDer == null) return { ok: false };
    const leaf = new X509Certificate(leafDer);
    const intermediate = new X509Certificate(intermediateDer);
    const root = new X509Certificate(APPLE_APP_ATTEST_ROOT_CA);

    // Chain: leaf signed by intermediate, intermediate signed by Apple root.
    if (!leaf.verify(intermediate.publicKey)) return { ok: false };
    if (!intermediate.verify(root.publicKey)) return { ok: false };
    const now = Date.now();
    for (const c of [leaf, intermediate]) {
      if (now < Date.parse(c.validFrom) || now > Date.parse(c.validTo)) return { ok: false };
    }

    const authData = Buffer.from(att.authData);
    const clientDataHash = sha256(Buffer.from(challenge));
    const expectedNonce = sha256(authData, clientDataHash);
    const certNonce = nonceExtension(leaf);
    if (certNonce == null || !certNonce.equals(expectedNonce)) return { ok: false };

    // keyId == SHA256(leaf public key) == credentialId carried in authData.
    const pubDer = leaf.publicKey.export({ type: 'spki', format: 'der' });
    const pubHash = sha256(Buffer.from(pubDer));
    const { rpIdHash, signCount, credentialId } = parseAuthData(authData);
    if (credentialId == null || !credentialId.equals(pubHash)) return { ok: false };
    if (!Buffer.from(keyId, 'base64').equals(pubHash)) return { ok: false };
    if (!rpIdHash.equals(appIdHash(cfg.teamId, cfg.bundleId))) return { ok: false };
    if (signCount !== 0) return { ok: false };

    return {
      ok: true,
      publicKeyPem: leaf.publicKey.export({ type: 'spki', format: 'pem' }),
      signCount: 0,
    };
  } catch {
    return { ok: false };
  }
}

// Validates a per-request assertion produced by DCAppAttestService.generateAssertion.
export function verifyAssertion(
  assertionB64: string,
  challenge: string,
  storedPublicKeyPem: string,
  storedSignCount: number,
  cfg: AttestVerifyInput,
): AssertionResult {
  try {
    const assertion = cborDecode(Buffer.from(assertionB64, 'base64')) as {
      signature: Uint8Array;
      authenticatorData: Uint8Array;
    };
    const authData = Buffer.from(assertion.authenticatorData);
    const clientDataHash = sha256(Buffer.from(challenge));
    const nonce = sha256(authData, clientDataHash);

    const pubKey = createPublicKey(storedPublicKeyPem);
    const valid = cryptoVerify('sha256', nonce, pubKey, Buffer.from(assertion.signature));
    if (!valid) return { ok: false };

    const { rpIdHash, signCount } = parseAuthData(authData);
    if (!rpIdHash.equals(appIdHash(cfg.teamId, cfg.bundleId))) return { ok: false };
    if (signCount <= storedSignCount) return { ok: false };

    return { ok: true, newSignCount: signCount };
  } catch {
    return { ok: false };
  }
}
