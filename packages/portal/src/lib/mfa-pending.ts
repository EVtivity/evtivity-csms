// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** A second factor the MFA step of a sign-in can take. */
export type MfaFactor = 'email' | 'sms' | 'totp' | 'recovery_code' | 'passkey';

const MFA_FACTORS: readonly MfaFactor[] = ['email', 'sms', 'totp', 'recovery_code', 'passkey'];

/** Characters in a recovery code without its dash. */
export const RECOVERY_CODE_LENGTH = 10;

/** The MFA pending state the portal login hands to the MFA step. */
export interface MfaPendingState {
  mfaRequired: true;
  mfaMethod: string;
  mfaToken: string;
  challengeId?: string;
  /** The factors the challenge accepts. Unknown (older API) means the primary method only. */
  factors?: MfaFactor[];
  /** The primary method is switched off by an admin: no code was sent, a recovery code is needed. */
  mfaMethodDisabled?: boolean;
}

/** The MFA pending reply of POST /v1/portal/auth/login. */
export interface MfaPendingReply {
  mfaRequired: true;
  mfaMethod: string;
  mfaToken: string;
  challengeId?: string | number;
  factors?: string[];
  mfaMethodDisabled?: boolean;
}

export function mfaPendingFromReply(data: MfaPendingReply): MfaPendingState {
  return {
    mfaRequired: true,
    mfaMethod: data.mfaMethod,
    mfaToken: data.mfaToken,
    ...(data.challengeId != null ? { challengeId: String(data.challengeId) } : {}),
    ...(data.factors != null
      ? {
          factors: data.factors.filter((v): v is MfaFactor =>
            (MFA_FACTORS as readonly string[]).includes(v),
          ),
        }
      : {}),
    ...(data.mfaMethodDisabled === true ? { mfaMethodDisabled: true } : {}),
  };
}

/** Whether the challenge offers recovery codes. */
export function offersRecoveryCode(pending: MfaPendingState): boolean {
  return pending.factors?.includes('recovery_code') === true;
}

/** Whether a passkey or security key is accepted (the page still needs WebAuthn to use one). */
export function offersPasskey(pending: MfaPendingState): boolean {
  return pending.factors?.includes('passkey') === true;
}

/** Whether the primary method's code is accepted. A passkey-only driver has no code method. */
export function offersPrimaryMethod(pending: MfaPendingState): boolean {
  if (pending.mfaMethodDisabled === true || pending.mfaMethod === 'passkey') return false;
  if (pending.factors == null) return true;
  return pending.factors.some((f) => f === pending.mfaMethod);
}

/** A recovery code as typed (`abcde-12345`, spaces, upper case) in the form the API compares. */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toLowerCase();
}
