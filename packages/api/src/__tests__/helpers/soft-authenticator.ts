// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';

/**
 * A software WebAuthn authenticator for tests: an ES256 (P-256) key pair, the
 * "none" attestation format and real signatures, so responses go through the
 * full @simplewebauthn/server verification. Each field of a ceremony can be
 * changed to build a response the server must refuse.
 */
export interface SoftAuthenticatorOptions {
  /** Report user verification (a PIN or biometric) in the flags. */
  userVerified?: boolean;
  /** Backup eligible and backed up: a synced passkey (multiDevice). */
  backedUp?: boolean;
  /** The signature counter the next response starts from. */
  counter?: number;
  /** Fixed credential id (base64url); random otherwise. */
  credentialId?: string;
}

export interface CeremonyOverrides {
  origin?: string;
  rpId?: string;
  challenge?: string;
  counter?: number;
  userVerified?: boolean;
  type?: string;
  userHandle?: string;
}

const AAGUID = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

export class SoftAuthenticator {
  readonly credentialId: string;
  private readonly privateKey: KeyObject;
  private readonly cosePublicKey: Buffer;
  private counter: number;
  private readonly userVerified: boolean;
  private readonly backedUp: boolean;

  constructor(opts: SoftAuthenticatorOptions = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(String(jwk.x), 'base64url')],
      [-3, Buffer.from(String(jwk.y), 'base64url')],
    ]);
    this.cosePublicKey = Buffer.from(isoCBOR.encode(cose));
    this.credentialId = opts.credentialId ?? randomBytes(16).toString('base64url');
    this.counter = opts.counter ?? 0;
    this.userVerified = opts.userVerified ?? true;
    this.backedUp = opts.backedUp ?? true;
  }

  private flags(userVerified: boolean, attested: boolean): number {
    let flags = 0x01;
    if (userVerified) flags |= 0x04;
    if (this.backedUp) flags |= 0x08 | 0x10;
    if (attested) flags |= 0x40;
    return flags;
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
  }

  /** A registration response (navigator.credentials.create) for the given options. */
  register(
    options: { challenge: string; rp: { id?: string } },
    origin: string,
    overrides: CeremonyOverrides = {},
  ): RegistrationResponseJSON {
    const rpId = overrides.rpId ?? options.rp.id ?? '';
    const idBytes = Buffer.from(this.credentialId, 'base64url');
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(idBytes.length, 0);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(overrides.userVerified ?? this.userVerified, true)]),
      u32(overrides.counter ?? this.counter),
      AAGUID,
      idLength,
      idBytes,
      this.cosePublicKey,
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]) as unknown as Parameters<typeof isoCBOR.encode>[0],
    );
    const clientDataJSON = this.clientData(
      overrides.type ?? 'webauthn.create',
      overrides.challenge ?? options.challenge,
      overrides.origin ?? origin,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: Buffer.from(attestationObject).toString('base64url'),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** An assertion (navigator.credentials.get); the counter goes up by one per call. */
  authenticate(
    options: { challenge: string; rpId?: string },
    origin: string,
    userHandle: string | undefined,
    overrides: CeremonyOverrides = {},
  ): AuthenticationResponseJSON {
    this.counter += 1;
    const counter = overrides.counter ?? this.counter;
    const authData = Buffer.concat([
      sha256(overrides.rpId ?? options.rpId ?? ''),
      Buffer.from([this.flags(overrides.userVerified ?? this.userVerified, false)]),
      u32(counter),
    ]);
    const clientDataJSON = this.clientData(
      overrides.type ?? 'webauthn.get',
      overrides.challenge ?? options.challenge,
      overrides.origin ?? origin,
    );
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.privateKey,
    );
    const handle = overrides.userHandle ?? userHandle;
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        ...(handle != null ? { userHandle: handle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
