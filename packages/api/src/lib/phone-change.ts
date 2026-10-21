// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { client } from '@evtivity/database';
import { verifyMfaChallenge } from '@evtivity/lib';
import { config } from './config.js';
import {
  checkFactorProof,
  factorProofKindsOf,
  holdsFactor,
  proofAccountOf,
  type FactorProof,
} from './mfa-factor-proof.js';
import type { MfaAccount } from '../services/mfa-factor.service.js';
import { normalizedPhone } from './phone-input.js';

export {
  INVALID_PHONE_REPLY,
  normalizedPhone,
  phoneToStore,
  readPhoneInput,
  type PhoneInput,
} from './phone-input.js';

/**
 * The challenge method of a code sent to a new phone number. The challenge is
 * bound to the number, so its code confirms only that number, and never a
 * sign-in, an SMS setup or a factor proof.
 */
export const PHONE_CHANGE_METHOD = 'phone_change';

export const phoneVerification = z
  .object({
    challengeId: z.coerce
      .number()
      .int()
      .min(1)
      .describe('The challengeId the verification route returned'),
    code: z.string().min(6).max(6).describe('The 6-digit code sent to the new number'),
  })
  .describe(
    'With SMS codes as the sign-in method: the code POST .../phone-verification sent to the new number',
  );
export type PhoneVerification = z.infer<typeof phoneVerification>;

/**
 * Why no code goes to a new number, or null when one may: only an account that
 * signs in with SMS codes confirms a new number, and never its current one, so
 * the route cannot text arbitrary numbers.
 */
export function phoneVerificationRefusal(
  account: { mfaEnabled: boolean; mfaMethod: string | null; phone: string | null },
  phone: string,
): string | null {
  if (!account.mfaEnabled || account.mfaMethod !== 'sms') {
    return 'Only an account that signs in with SMS codes confirms a new number';
  }
  if (normalizedPhone(account.phone) === phone) return 'This is already your number';
  return null;
}

/** Why a phone change was refused: the 400 reply the route sends. */
export interface PhoneChangeRefusal {
  status: 400;
  body: { error: string; code: string } & Record<string, unknown>;
}

/** What a self-service phone change carries next to the number. */
export interface PhoneChange {
  current: string | null;
  next: string | null;
  proof?: FactorProof | undefined;
  verification?: PhoneVerification | undefined;
  /** A request signed in with a token of the mobile app, which sends no proof. */
  mobileSession?: boolean;
}

/**
 * Checks a phone change the account makes itself. SMS codes go to that number,
 * so a stolen session must not be able to move them: an account with a factor
 * proves itself (its current factor, as to add one), and an account that signs
 * in with SMS codes also confirms the new number with the code sent to it, a
 * challenge only a proof could have started. An account without a factor needs
 * nothing. Null when the change may be saved.
 */
export async function checkPhoneChange(
  request: FastifyRequest,
  account: MfaAccount,
  change: PhoneChange,
): Promise<PhoneChangeRefusal | null> {
  if (change.next === change.current) return null;
  const proofAccount = await proofAccountOf(account);
  if (proofAccount == null) return null;
  if (!holdsFactor(factorProofKindsOf(proofAccount))) return null;

  if (change.mobileSession === true && change.proof == null && change.verification == null) {
    const error = `Changing the phone number of an account with two-factor authentication needs a confirmation this app cannot give yet. Change it in the driver portal at ${config.PORTAL_URL}.`;
    return {
      status: 400,
      body: {
        error,
        code: 'VALIDATION_ERROR',
        details: { phone: error },
        portalUrl: config.PORTAL_URL,
      },
    };
  }

  if (proofAccount.mfaEnabled && proofAccount.mfaMethod === 'sms' && change.next != null) {
    if (change.verification == null) {
      return {
        status: 400,
        body: {
          error: 'Confirm the new number with the code sent to it',
          code: 'VALIDATION_ERROR',
          phoneVerificationRequired: true,
        },
      };
    }
    const result = await verifyMfaChallenge(
      client,
      change.verification.challengeId,
      change.verification.code,
      { ...account, method: PHONE_CHANGE_METHOD, purpose: 'setup', destination: change.next },
    );
    if (result === 'verified') return null;
    if (result === 'exhausted') {
      return {
        status: 400,
        body: {
          error: 'Too many tries for this code, send a new one',
          code: 'MFA_CHALLENGE_EXHAUSTED',
        },
      };
    }
    return { status: 400, body: { error: 'Invalid verification code', code: 'MFA_CODE_INVALID' } };
  }

  return checkFactorProof(request, account, change.proof);
}
