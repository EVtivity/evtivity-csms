// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { client, db, drivers, users } from '@evtivity/database';
import { decryptString, matchTotpStep, verifyMfaChallenge } from '@evtivity/lib';
import { config } from './config.js';
import { getAuditActor } from './audit-actor.js';
import { mfaCodeDestination } from './mfa-contact.js';
import { passwordAuthBlocked } from './operator-session.js';
import { verifyPassword } from './password-verify.js';
import {
  acceptTotpStep,
  clearSignInFailures,
  recordAttemptFailure,
  takeSignInAttempt,
} from './sign-in-backoff.js';
import { takeWebauthnChallenge } from './webauthn-challenges.js';
import { isChallengeFor } from './webauthn-challenge-records.js';
import {
  WebauthnVerificationError,
  checkAuthentication,
  responseChallenge,
  webauthnRpFor,
} from './webauthn.js';
import {
  consumeRecoveryCode,
  countRecoveryCodes,
  countWebauthnCredentials,
  findWebauthnCredential,
  recordWebauthnCredentialUse,
  type MfaAccount,
  type StoredWebauthnCredential,
} from '../services/mfa-factor.service.js';

const base64url = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9_-]+$/);

/** The PublicKeyCredential of navigator.credentials.get, as JSON. */
export const authenticationCredential = z
  .object({
    id: base64url.describe('Credential id (base64url)'),
    rawId: base64url.describe('Credential id (base64url)'),
    type: z.literal('public-key').describe('Always public-key'),
    response: z
      .object({
        clientDataJSON: base64url.describe('Client data (base64url)'),
        authenticatorData: base64url.describe('Authenticator data (base64url)'),
        signature: base64url.describe('Assertion signature (base64url)'),
        userHandle: z.string().max(1024).optional().describe('User handle (base64url)'),
      })
      .passthrough()
      .describe('Authenticator assertion response'),
    authenticatorAttachment: z
      .enum(['platform', 'cross-platform'])
      .optional()
      .describe('Platform (built-in) or cross-platform (security key, phone)'),
    clientExtensionResults: z.record(z.unknown()).describe('Client extension results'),
  })
  .passthrough()
  .describe('The PublicKeyCredential of navigator.credentials.get, as JSON');

export const FACTOR_PROOF_KINDS = [
  'totp',
  'code',
  'passkey',
  'password',
  'sso',
  'recovery_code',
] as const;

/**
 * How long an SSO sign-in proves an SSO account without a password or factor
 * (the `sso` proof): 10 minutes from the sign-in, read from the session's `ssoAt`.
 */
export const SSO_REAUTH_MAX_AGE_SECONDS = 10 * 60;

/** Until when the session's SSO sign-in proves the account, or null (no SSO sign-in, or too old). */
export function ssoProofUntil(request: FastifyRequest, now = Date.now()): Date | null {
  const at = (request.user as { ssoAt?: unknown } | undefined)?.ssoAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const until = (at + SSO_REAUTH_MAX_AGE_SECONDS) * 1000;
  // A sign-in time in the future is not one the API issued.
  if (at * 1000 > now + 60_000 || until <= now) return null;
  return new Date(until);
}
export type FactorProofKind = (typeof FACTOR_PROOF_KINDS)[number];

/**
 * A fresh proof sent with the call that adds an MFA factor (a passkey, or an
 * email, SMS or TOTP method). One flat object rather than a union: the request
 * validator strips unknown keys branch by branch, which would empty a union.
 */
export const factorProof = z
  .object({
    kind: z
      .enum(FACTOR_PROOF_KINDS)
      .describe(
        'totp: a code of the account authenticator app. code: the email or SMS code the factor-proof route sent (POST /v1/users/me/mfa/factor-proof, or /v1/portal/driver/mfa/factor-proof for drivers). passkey: a passkey or security key of the account, answering the options of that route. password: the current password, only for an account without a second factor. sso: an SSO account without a password or second factor, within 10 minutes of its SSO sign-in (sign in again with SSO, then send it). recovery_code: one of the account recovery codes (used up), accepted only to remove a factor or turn MFA off',
      ),
    code: z.string().min(6).max(6).optional().describe('totp and code: the 6-digit code'),
    challengeId: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe('code: the challengeId the factor-proof route returned'),
    credential: authenticationCredential
      .optional()
      .describe('passkey: the navigator.credentials.get response'),
    password: z.string().min(1).max(1024).optional().describe('password: the current password'),
    recoveryCode: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'recovery_code: a recovery code of the account, as written (dashes and spaces ignored)',
      ),
  })
  .describe(
    'Fresh proof of the account: its current factor when it has one (any of the kinds the MFA status lists in factorProofKinds, or lastFactorProofKinds to remove a factor or turn MFA off, which also accept a recovery code), else the password. An SSO account without a password or factor sends { kind: sso } within 10 minutes of an SSO sign-in.',
  );
export type FactorProof = z.infer<typeof factorProof>;

/** What an account can prove: the factor kinds it holds, else the password, else nothing. */
export function factorProofKindsOf(account: {
  mfaEnabled: boolean;
  mfaMethod: string | null;
  passkeyCount: number;
  hasPassword: boolean;
  ssoReauth?: boolean;
}): FactorProofKind[] {
  const kinds: FactorProofKind[] = [];
  if (account.mfaEnabled && account.mfaMethod === 'totp') kinds.push('totp');
  if (account.mfaEnabled && (account.mfaMethod === 'email' || account.mfaMethod === 'sms')) {
    kinds.push('code');
  }
  if (account.passkeyCount > 0) kinds.push('passkey');
  if (kinds.length === 0 && account.hasPassword) kinds.push('password');
  // An SSO account without a password or factor proves itself with a fresh SSO sign-in.
  if (kinds.length === 0 && account.ssoReauth === true) kinds.push('sso');
  return kinds;
}

/** Whether proof kinds mean the account holds a second factor (not only a password or SSO). */
export function holdsFactor(kinds: readonly FactorProofKind[]): boolean {
  return kinds.some((k) => k !== 'password' && k !== 'sso');
}

/**
 * Removing a factor or turning MFA off: while the account holds a factor, a
 * proof of a factor it holds or one of its recovery codes, never the password
 * alone (a stolen session with a phished password must not strip the factors).
 * An account without a factor proves itself as for adding one.
 */
export function lastFactorProofKindsOf(account: ProofAccount): FactorProofKind[] {
  const kinds = factorProofKindsOf(account);
  if (!holdsFactor(kinds)) return kinds;
  if ((account.recoveryCodeCount ?? 0) > 0) kinds.push('recovery_code');
  return kinds;
}

/** What a proof is for: adding a factor, or removing one. */
export type FactorProofPurpose = 'add' | 'remove';

/** The factors and password of an account, as the proof rules read them. */
export interface ProofAccount {
  mfaEnabled: boolean;
  mfaMethod: string | null;
  passkeyCount: number;
  hasPassword: boolean;
  /** An operator whose sign-in is SSO (an SSO account while SSO is enabled). */
  ssoReauth?: boolean;
  /** Unused recovery codes: a removal proof while the account holds a factor. */
  recoveryCodeCount?: number;
  /** The account's phone, which an SMS code of the `code` proof is bound to. */
  phone?: string | null;
}

/** The factors and password of an operator or driver account; null for an unknown one. */
export async function proofAccountOf(account: MfaAccount): Promise<ProofAccount | null> {
  if ('driverId' in account) {
    const [driver] = await db
      .select({
        mfaEnabled: drivers.mfaEnabled,
        mfaMethod: drivers.mfaMethod,
        passwordHash: drivers.passwordHash,
        phone: drivers.phone,
      })
      .from(drivers)
      .where(eq(drivers.id, account.driverId));
    if (driver == null) return null;
    return {
      mfaEnabled: driver.mfaEnabled,
      mfaMethod: driver.mfaMethod,
      passkeyCount: await countWebauthnCredentials(account),
      hasPassword: driver.passwordHash != null && driver.passwordHash !== '',
      recoveryCodeCount: await countRecoveryCodes(account),
      phone: driver.phone,
    };
  }
  const [user] = await db
    .select({
      mfaEnabled: users.mfaEnabled,
      mfaMethod: users.mfaMethod,
      passwordHash: users.passwordHash,
      authSource: users.authSource,
      phone: users.phone,
    })
    .from(users)
    .where(eq(users.id, account.userId));
  if (user == null) return null;
  // An SSO account while SSO is enabled has no password path, so its hash proves nothing.
  const ssoReauth = await passwordAuthBlocked(user);
  const hasPassword = user.passwordHash !== '' && !ssoReauth;
  return {
    mfaEnabled: user.mfaEnabled,
    mfaMethod: user.mfaMethod,
    passkeyCount: await countWebauthnCredentials(account),
    hasPassword,
    ssoReauth,
    recoveryCodeCount: await countRecoveryCodes(account),
    phone: user.phone,
  };
}

/** The proof kinds of an account for a purpose (empty for an unknown one). */
export async function factorProofKinds(
  account: MfaAccount,
  purpose: FactorProofPurpose = 'add',
): Promise<FactorProofKind[]> {
  const proofAccount = await proofAccountOf(account);
  if (proofAccount == null) return [];
  return purpose === 'add'
    ? factorProofKindsOf(proofAccount)
    : lastFactorProofKindsOf(proofAccount);
}

/** The stored password hash of an account. */
async function passwordHashOf(account: MfaAccount): Promise<string | null> {
  if ('driverId' in account) {
    const [driver] = await db
      .select({ passwordHash: drivers.passwordHash })
      .from(drivers)
      .where(eq(drivers.id, account.driverId));
    return driver?.passwordHash ?? null;
  }
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, account.userId));
  return user?.passwordHash ?? null;
}

/** The encrypted TOTP secret of an account. */
async function totpSecretOf(account: MfaAccount): Promise<string | null> {
  if ('driverId' in account) {
    const [driver] = await db
      .select({ totpSecretEnc: drivers.totpSecretEnc })
      .from(drivers)
      .where(eq(drivers.id, account.driverId));
    return driver?.totpSecretEnc ?? null;
  }
  const [user] = await db
    .select({ totpSecretEnc: users.totpSecretEnc })
    .from(users)
    .where(eq(users.id, account.userId));
  return user?.totpSecretEnc ?? null;
}

/** Why a proof was refused: the error reply the route sends. */
export interface FactorProofRefusal {
  status: 400;
  body: {
    error: string;
    code:
      | 'VALIDATION_ERROR'
      | 'MFA_CODE_INVALID'
      | 'MFA_CHALLENGE_EXHAUSTED'
      | 'INVALID_PASSWORD'
      | 'WEBAUTHN_CHALLENGE_EXPIRED'
      | 'WEBAUTHN_VERIFICATION_FAILED';
    proofKinds?: FactorProofKind[];
  };
}

function refusal(
  code: FactorProofRefusal['body']['code'],
  error: string,
  proofKinds?: FactorProofKind[],
): FactorProofRefusal {
  return { status: 400, body: { error, code, ...(proofKinds != null ? { proofKinds } : {}) } };
}

function proofMissingMessage(kinds: FactorProofKind[], purpose: FactorProofPurpose): string {
  if (purpose === 'remove') {
    return holdsFactor(kinds)
      ? 'Confirm with a factor you have or a recovery code'
      : 'Confirm with your current password';
  }
  return kinds.includes('password')
    ? 'Confirm with your current password to add a second factor'
    : 'Confirm with a factor you already have to add another one';
}

/**
 * Checks the fresh proof a signed-in operator or driver sends to add an MFA
 * factor, or to remove one or turn MFA off (`remove`). Null when it holds: the
 * account's current factor (a TOTP code accepted once, an email or SMS code of
 * a challenge, a passkey assertion of a `factor_add` challenge, and for
 * `remove` a recovery code), else the password, else a fresh SSO sign-in. An
 * account with none of them is refused: nothing can prove it.
 */
export async function checkFactorProof(
  request: FastifyRequest,
  account: MfaAccount,
  proof: FactorProof | undefined,
  purpose: FactorProofPurpose = 'add',
): Promise<FactorProofRefusal | null> {
  const proofAccount = await proofAccountOf(account);
  if (proofAccount == null) return null;
  const kinds =
    purpose === 'add' ? factorProofKindsOf(proofAccount) : lastFactorProofKindsOf(proofAccount);
  // Fail closed: an account without a factor, password or SSO sign-in (an SSO
  // account after SSO was turned off) has nothing to prove itself with.
  if (kinds.length === 0) {
    return refusal(
      'VALIDATION_ERROR',
      'This account has no factor or password to confirm with. Ask an administrator to reset its password.',
      [],
    );
  }
  if (proof == null || !kinds.includes(proof.kind)) {
    return refusal('VALIDATION_ERROR', proofMissingMessage(kinds, purpose), kinds);
  }

  switch (proof.kind) {
    case 'sso': {
      // The SSO callback stamps the access token it issues; a stolen session
      // cannot do the identity provider round trip.
      if (ssoProofUntil(request) == null) {
        return refusal(
          'VALIDATION_ERROR',
          'Sign in again with single sign-on, then confirm within 10 minutes',
          kinds,
        );
      }
      return null;
    }
    case 'password': {
      if (proof.password == null) {
        return refusal('VALIDATION_ERROR', 'Send the current password', kinds);
      }
      // A wrong password counts toward the account's sign-in backoff, as at sign-in, so a
      // stolen session cannot guess it here; while locked the password is not checked. The
      // try is counted in the UPDATE that checks the lock, so parallel guesses cannot pass it.
      const attempt = await takeSignInAttempt(account, 'password');
      if (!attempt.granted) return refusal('INVALID_PASSWORD', 'Invalid password');
      if (!(await verifyPassword(await passwordHashOf(account), proof.password, request.log))) {
        await recordAttemptFailure(request, attempt);
        return refusal('INVALID_PASSWORD', 'Invalid password');
      }
      await clearSignInFailures(account, 'password');
      return null;
    }
    case 'totp': {
      if (proof.code == null) {
        return refusal('VALIDATION_ERROR', 'Send the code from your authenticator app', kinds);
      }
      const attempt = await takeSignInAttempt(account, 'proof');
      if (!attempt.granted) return refusal('MFA_CODE_INVALID', 'Invalid verification code');
      const secretEnc = await totpSecretOf(account);
      let step: number | null = null;
      if (secretEnc != null) {
        try {
          step = matchTotpStep(
            decryptString(secretEnc, config.SETTINGS_ENCRYPTION_KEY),
            proof.code,
          );
        } catch (err: unknown) {
          request.log.warn({ err, account }, 'TOTP secret decrypt failed, refusing the proof');
        }
      }
      // A code is accepted once, as at sign-in, and a wrong one counts toward the MFA backoff.
      if (step == null || !(await acceptTotpStep(account, step))) {
        await recordAttemptFailure(request, attempt);
        return refusal('MFA_CODE_INVALID', 'Invalid verification code');
      }
      await clearSignInFailures(account, 'proof');
      return null;
    }
    case 'code': {
      if (proof.code == null || proof.challengeId == null) {
        return refusal('VALIDATION_ERROR', 'Send the code and its challengeId', kinds);
      }
      const attempt = await takeSignInAttempt(account, 'proof');
      if (!attempt.granted) return refusal('MFA_CODE_INVALID', 'Invalid verification code');
      // The code must have been sent as a proof for the account's method, and an SMS
      // code to the account's number.
      const result = await verifyMfaChallenge(client, proof.challengeId, proof.code, {
        ...account,
        method: proofAccount.mfaMethod ?? '',
        purpose: 'proof',
        destination: mfaCodeDestination(proofAccount.mfaMethod, {
          phone: proofAccount.phone ?? null,
        }),
      });
      if (result === 'verified') {
        await clearSignInFailures(account, 'proof');
        return null;
      }
      await recordAttemptFailure(request, attempt);
      // A code with no tries left can never pass: the caller sends a new one.
      if (result === 'exhausted') {
        return refusal('MFA_CHALLENGE_EXHAUSTED', 'Too many tries for this code, send a new one');
      }
      return refusal('MFA_CODE_INVALID', 'Invalid verification code');
    }
    case 'recovery_code': {
      if (proof.recoveryCode == null) {
        return refusal('VALIDATION_ERROR', 'Send a recovery code', kinds);
      }
      // A wrong code counts on the proof backoff, as a wrong TOTP or emailed code does.
      const attempt = await takeSignInAttempt(account, 'proof');
      if (!attempt.granted) return refusal('MFA_CODE_INVALID', 'Invalid recovery code');
      const used = await consumeRecoveryCode(account, proof.recoveryCode, {
        actor: getAuditActor(request),
        log: request.log,
      });
      if (!used.used) {
        await recordAttemptFailure(request, attempt);
        return refusal('MFA_CODE_INVALID', 'Invalid recovery code');
      }
      await clearSignInFailures(account, 'proof');
      return null;
    }
    case 'passkey': {
      if (proof.credential == null) {
        return refusal('VALIDATION_ERROR', 'Send the passkey response', kinds);
      }
      const credential = proof.credential as unknown as AuthenticationResponseJSON;
      const challenge = responseChallenge(credential);
      const record = challenge != null ? await takeWebauthnChallenge(challenge) : null;
      if (challenge == null || !isChallengeFor(record, 'factor_add', account)) {
        return refusal(
          'WEBAUTHN_CHALLENGE_EXPIRED',
          'The passkey request expired or was already used',
        );
      }
      const stored = await findWebauthnCredential(credential.id);
      if (
        stored == null ||
        !(await verifyAccountAssertion(request, account, credential, challenge, stored, false))
      ) {
        return refusal(
          'WEBAUTHN_VERIFICATION_FAILED',
          'The passkey or security key could not be verified',
        );
      }
      return null;
    }
  }
}

export async function sendFactorProofRefusal(
  reply: FastifyReply,
  refused: FactorProofRefusal,
): Promise<void> {
  await reply.status(refused.status).send(refused.body);
}

/** Whether a stored credential belongs to the account (an operator's never verifies for a driver). */
function credentialOwnedBy(stored: StoredWebauthnCredential, account: MfaAccount): boolean {
  return 'userId' in account
    ? stored.userId === account.userId && stored.driverId == null
    : stored.driverId === account.driverId && stored.userId == null;
}

/**
 * Verifies an assertion against a stored credential of the account, at the
 * account's relying party (the CSMS for operators, the portal for drivers),
 * and records the use; false when the credential belongs to another account,
 * it does not verify, or it lost a counter race.
 */
export async function verifyAccountAssertion(
  request: FastifyRequest,
  account: MfaAccount,
  credential: AuthenticationResponseJSON,
  challenge: string,
  stored: StoredWebauthnCredential,
  requireUserVerification: boolean,
): Promise<boolean> {
  if (!credentialOwnedBy(stored, account)) return false;
  let result;
  try {
    result = await checkAuthentication(credential, challenge, webauthnRpFor(account), stored, {
      requireUserVerification,
    });
  } catch (err) {
    if (!(err instanceof WebauthnVerificationError)) throw err;
    request.log.info({ err: err.cause, credentialId: stored.id }, 'WebAuthn assertion refused');
    return false;
  }
  return recordWebauthnCredentialUse(stored, {
    newCounter: result.newCounter,
    backedUp: result.backedUp,
  });
}
