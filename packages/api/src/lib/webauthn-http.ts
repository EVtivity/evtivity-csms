// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { readMfaConfig } from '@evtivity/database';
import { passkeysAccepted } from './mfa-factors.js';
import { FACTOR_PROOF_KINDS, verifyAccountAssertion } from './mfa-factor-proof.js';
import { responseChallenge } from './webauthn.js';
import { takeWebauthnChallenge } from './webauthn-challenges.js';
import { isChallengeFor } from './webauthn-challenge-records.js';
import { findWebauthnCredential, type MfaAccount } from '../services/mfa-factor.service.js';

// Request and reply shapes and checks the operator (routes/webauthn.ts) and driver
// (routes/portal/webauthn.ts) passkey routes share.

const base64url = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9_-]+$/);

export const registrationCredential = z
  .object({
    id: base64url.describe('Credential id (base64url)'),
    rawId: base64url.describe('Credential id (base64url)'),
    type: z.literal('public-key').describe('Always public-key'),
    response: z
      .object({
        clientDataJSON: base64url.describe('Client data (base64url)'),
        attestationObject: base64url.describe('Attestation object (base64url)'),
        transports: z.array(z.string().max(32)).max(10).optional().describe('Transports'),
      })
      .passthrough()
      .describe('Authenticator attestation response'),
    authenticatorAttachment: z
      .enum(['platform', 'cross-platform'])
      .optional()
      .describe('Platform (built-in) or cross-platform (security key, phone)'),
    clientExtensionResults: z.record(z.unknown()).describe('Client extension results'),
  })
  .passthrough()
  .describe('The PublicKeyCredential of navigator.credentials.create, as JSON');

// Control and format characters (bidi overrides, zero-width spaces) are dropped before the
// length check, so a name cannot be blank or spoof another in the list.
const CREDENTIAL_NAME_INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
export const credentialName = z.string().min(1).max(200);

/** The stored name: invisible characters dropped, trimmed, 1 to 100 characters, else null. */
export function cleanCredentialName(raw: string): string | null {
  const name = raw.replace(CREDENTIAL_NAME_INVISIBLE, '').trim();
  return name.length >= 1 && name.length <= 100 ? name : null;
}

export const credentialItem = z
  .object({
    id: z
      .number()
      .int()
      .describe('Credential identifier (the :id of the rename and remove routes)'),
    name: z.string().describe('Name the user gave the credential'),
    deviceType: z
      .string()
      .describe('singleDevice (bound to one authenticator) or multiDevice (a synced passkey)'),
    backedUp: z.boolean().describe('Whether the credential is backed up (synced)'),
    transports: z.array(z.string()).describe('How the browser reaches the authenticator'),
    aaguid: z
      .string()
      .nullable()
      .describe('Authenticator model id, when the authenticator gave one'),
    createdAt: z.string().describe('When the credential was registered (ISO 8601)'),
    lastUsedAt: z.string().nullable().describe('Last sign-in with it (ISO 8601)'),
  })
  .passthrough();

export const creationOptions = z
  .object({
    challenge: z.string().describe('Challenge (base64url), valid for 5 minutes and one response'),
    rp: z
      .object({ id: z.string().optional(), name: z.string() })
      .passthrough()
      .describe('Relying party: the RP ID and the company name'),
    user: z
      .object({ id: z.string(), name: z.string(), displayName: z.string() })
      .passthrough()
      .describe('WebAuthn user: handle, email and name'),
    pubKeyCredParams: z
      .array(z.object({ alg: z.number(), type: z.string() }).passthrough())
      .describe('Accepted public key algorithms'),
    timeout: z.number().optional().describe('Prompt timeout in milliseconds'),
    excludeCredentials: z
      .array(z.object({ id: z.string(), type: z.string() }).passthrough())
      .optional()
      .describe('Credentials already registered'),
    attestation: z.string().optional().describe('Always none'),
  })
  .passthrough()
  .describe('PublicKeyCredentialCreationOptionsJSON for navigator.credentials.create');

export const requestOptions = z
  .object({
    challenge: z.string().describe('Challenge (base64url), valid for 5 minutes and one response'),
    rpId: z.string().optional().describe('Relying party ID'),
    timeout: z.number().optional().describe('Prompt timeout in milliseconds'),
    userVerification: z.string().optional().describe('required (passkey sign-in) or preferred'),
    allowCredentials: z
      .array(z.object({ id: z.string(), type: z.string() }).passthrough())
      .optional()
      .describe('The account credentials (second factor only)'),
  })
  .passthrough()
  .describe('PublicKeyCredentialRequestOptionsJSON for navigator.credentials.get');

export const registrationResponse = z
  .object({
    credential: credentialItem.describe('The registered credential'),
    recoveryCodes: z
      .array(z.string())
      .optional()
      .describe('Ten recovery codes, when the credential is the first factor of the account'),
  })
  .passthrough();

export const idParams = z.object({
  id: z.coerce.number().int().min(1).describe('Credential identifier'),
});

export const proofKindsField = z
  .array(z.enum(FACTOR_PROOF_KINDS))
  .optional()
  .describe('VALIDATION_ERROR of a missing or wrong proof: the proof kinds the account accepts');

/** A credential row as the list, rename and registration replies show it. */
export function serializeCredential(row: {
  id: number;
  name: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  aaguid: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

export async function sendChallengeExpired(reply: FastifyReply): Promise<void> {
  await reply.status(400).send({
    error: 'The passkey request expired or was already used',
    code: 'WEBAUTHN_CHALLENGE_EXPIRED',
  });
}

export async function sendVerificationFailed(reply: FastifyReply): Promise<void> {
  await reply.status(400).send({
    error: 'The passkey or security key could not be verified',
    code: 'WEBAUTHN_VERIFICATION_FAILED',
  });
}

/** The name of a new credential when the user gives none. */
export function defaultCredentialName(credential: RegistrationResponseJSON): string {
  return credential.authenticatorAttachment === 'cross-platform' ? 'Security Key' : 'Passkey';
}

export const factorProofBody = z.object({
  kind: z
    .enum(['code', 'passkey'])
    .describe(
      'code: send a code to the email or SMS method of the account. passkey: options for a passkey or security key of the account',
    ),
});

export const factorProofResponse = z
  .object({
    challengeId: z
      .number()
      .int()
      .optional()
      .describe('code: send it back as proof.challengeId with the code'),
    options: requestOptions
      .optional()
      .describe(
        'passkey: the options for navigator.credentials.get; send the response as proof.credential',
      ),
  })
  .passthrough();

/** The outcome of a passkey proof for new recovery codes. */
export type RecoveryCodesPasskeyProof = 'verified' | 'challenge_expired' | 'failed';

/**
 * Checks a passkey proof for new recovery codes (POST /v1/users/me/mfa/recovery-codes,
 * POST /v1/portal/driver/mfa/recovery-codes): the challenge of the recovery codes
 * options for this account, and a credential of this account that verifies.
 */
export async function verifyRecoveryCodesPasskey(
  request: FastifyRequest,
  account: MfaAccount,
  credential: AuthenticationResponseJSON,
): Promise<RecoveryCodesPasskeyProof> {
  const challenge = responseChallenge(credential);
  const record = challenge != null ? await takeWebauthnChallenge(challenge) : null;
  if (challenge == null || !isChallengeFor(record, 'recovery_regenerate', account)) {
    return 'challenge_expired';
  }
  const stored = await findWebauthnCredential(credential.id);
  if (stored == null) return 'failed';
  return (await verifyAccountAssertion(request, account, credential, challenge, stored, false))
    ? 'verified'
    : 'failed';
}

/** Passkey sign-in needs both switches; a failed settings read keeps it off. */
export async function passkeyLoginAllowed(): Promise<boolean> {
  const reading = await readMfaConfig();
  return !reading.fallback && passkeysAccepted(reading) && reading.config.passkeyLoginEnabled;
}
