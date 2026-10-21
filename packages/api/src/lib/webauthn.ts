// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { tryParseJson } from '@evtivity/lib';
import { config } from './config.js';
import {
  driverRelyingParty,
  operatorRelyingParty,
  type WebauthnRelyingParty,
} from './webauthn-rp.js';

export type { WebauthnRelyingParty } from './webauthn-rp.js';

/** How long the browser prompt waits, in milliseconds (the challenge itself lives 5 minutes). */
const CEREMONY_TIMEOUT_MS = 120_000;

const KNOWN_TRANSPORTS: ReadonlySet<string> = new Set(['ble', 'hybrid', 'internal', 'nfc', 'usb']);

/** A response the server refuses: wrong challenge, origin, RP ID, signature, counter or flags. */
export class WebauthnVerificationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WebauthnVerificationError';
  }
}

/** The relying party of operator ceremonies (CSMS origin; RP ID per WEBAUTHN_RP_ID or the CSMS host). */
export function operatorWebauthnRp(): WebauthnRelyingParty {
  return operatorRelyingParty(config.WEBAUTHN_RP_ID, config.CSMS_URL);
}

/**
 * The relying party of driver ceremonies (portal origin; RP ID per WEBAUTHN_RP_ID when it
 * is a parent of the portal host, else the portal host).
 */
export function driverWebauthnRp(): WebauthnRelyingParty {
  return driverRelyingParty(config.WEBAUTHN_RP_ID, config.PORTAL_URL);
}

/** The relying party of an account's ceremonies: the CSMS for operators, the portal for drivers. */
export function webauthnRpFor(
  account: { userId: string } | { driverId: string },
): WebauthnRelyingParty {
  return 'userId' in account ? operatorWebauthnRp() : driverWebauthnRp();
}

/** A new WebAuthn user handle: 32 random bytes, base64url, never the account id. */
export function newUserHandle(): string {
  return randomBytes(32).toString('base64url');
}

function transportsOf(values: readonly string[]): AuthenticatorTransport[] {
  return values.filter((t): t is AuthenticatorTransport => KNOWN_TRANSPORTS.has(t));
}

/**
 * The challenge a response answers, from its clientDataJSON, or null when the
 * response carries none. The verify routes use it to find the stored challenge.
 */
export function responseChallenge(response: {
  response?: { clientDataJSON?: unknown };
}): string | null {
  const clientDataJSON = response.response?.clientDataJSON;
  if (typeof clientDataJSON !== 'string' || clientDataJSON === '') return null;
  // Buffer ignores characters outside base64url, so a malformed value decodes to text
  // that is not JSON and answers null.
  const decoded = tryParseJson(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
  if (decoded == null || typeof decoded !== 'object') return null;
  const challenge = (decoded as Record<string, unknown>)['challenge'];
  return typeof challenge === 'string' && challenge !== '' ? challenge : null;
}

export interface RegistrationOptionsInput {
  rp: WebauthnRelyingParty;
  rpName: string;
  userName: string;
  userDisplayName: string;
  userHandle: string;
  exclude: { credentialId: string; transports: string[] }[];
}

/**
 * Registration options: no attestation (only the public key is kept), a
 * discoverable credential preferred so the passkey can also sign in, and
 * user verification preferred so a security key without a PIN still works
 * as a second factor.
 */
export async function buildRegistrationOptions(
  input: RegistrationOptionsInput,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: input.rpName,
    rpID: input.rp.rpId,
    userName: input.userName,
    userDisplayName: input.userDisplayName,
    userID: Buffer.from(input.userHandle, 'base64url'),
    attestationType: 'none',
    timeout: CEREMONY_TIMEOUT_MS,
    excludeCredentials: input.exclude.map((c) => ({
      id: c.credentialId,
      transports: transportsOf(c.transports),
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
}

/** What a verified registration gives to store. */
export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  aaguid: string | null;
  userVerified: boolean;
}

const EMPTY_AAGUID = '00000000-0000-0000-0000-000000000000';

/** Verifies a registration against the stored challenge, the origin and the RP ID. */
export async function checkRegistration(
  response: RegistrationResponseJSON,
  challenge: string,
  rp: WebauthnRelyingParty,
): Promise<VerifiedRegistration> {
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: false,
    });
  } catch (err) {
    throw new WebauthnVerificationError('Registration response did not verify', { cause: err });
  }
  if (!result.verified) throw new WebauthnVerificationError('Registration response did not verify');
  const info = result.registrationInfo;
  return {
    credentialId: info.credential.id,
    publicKey: info.credential.publicKey,
    counter: info.credential.counter,
    transports: transportsOf(info.credential.transports ?? response.response.transports ?? []),
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    aaguid: info.aaguid === EMPTY_AAGUID ? null : info.aaguid,
    userVerified: info.userVerified,
  };
}

/**
 * Authentication options. With `allow` (a second factor) the browser offers
 * the account's credentials; without it (passkey sign-in) any discoverable
 * credential for the RP ID.
 */
export async function buildAuthenticationOptions(
  rp: WebauthnRelyingParty,
  opts: {
    allow?: { credentialId: string; transports: string[] }[];
    userVerification: 'required' | 'preferred';
  },
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rp.rpId,
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: opts.userVerification,
    ...(opts.allow != null
      ? {
          allowCredentials: opts.allow.map((c) => ({
            id: c.credentialId,
            transports: transportsOf(c.transports),
          })),
        }
      : {}),
  });
}

export interface VerifiedAuthentication {
  newCounter: number;
  userVerified: boolean;
  backedUp: boolean;
}

/**
 * Verifies an assertion against the stored challenge, the origin, the RP ID
 * and the stored public key. A signature counter that does not go up (when
 * either counter is above 0) is refused: a sign of a cloned authenticator.
 */
export async function checkAuthentication(
  response: AuthenticationResponseJSON,
  challenge: string,
  rp: WebauthnRelyingParty,
  credential: {
    credentialId: string;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
  },
  opts: { requireUserVerification: boolean },
): Promise<VerifiedAuthentication> {
  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
        transports: transportsOf(credential.transports),
      },
      requireUserVerification: opts.requireUserVerification,
    });
  } catch (err) {
    throw new WebauthnVerificationError('Authentication response did not verify', { cause: err });
  }
  if (!result.verified) {
    throw new WebauthnVerificationError('Authentication response did not verify');
  }
  return {
    newCounter: result.authenticationInfo.newCounter,
    userVerified: result.authenticationInfo.userVerified,
    backedUp: result.authenticationInfo.credentialBackedUp,
  };
}
