// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { MfaConfig, MfaConfigReading } from '@evtivity/database';

export const MFA_FACTORS = ['email', 'sms', 'totp', 'recovery_code', 'passkey'] as const;
export type MfaFactor = (typeof MFA_FACTORS)[number];

/** The second factors an operator or driver holds. */
export interface MfaFactorAccount {
  mfaEnabled: boolean;
  mfaMethod: string | null;
  recoveryCodesRemaining?: number;
  passkeyCount?: number;
}

/** What sign-in does with the account's primary MFA method. */
export type MfaMethodGate = 'allowed' | 'enrollment_required' | 'refused';

export function isMfaMethodAllowed(method: string, config: MfaConfig): boolean {
  switch (method) {
    case 'email':
      return config.emailEnabled;
    case 'totp':
      return config.totpEnabled;
    case 'sms':
      return config.smsEnabled;
    default:
      return false;
  }
}

/**
 * Whether the switch of the method is on. When the settings read failed, the
 * switches are the code defaults (SMS off), so a method the defaults switch off
 * counts as off: `usableFactors` still keeps it while it is the only factor.
 */
function methodAccepted(method: string, reading: MfaConfigReading): boolean {
  return isMfaMethodAllowed(method, reading.config);
}

/**
 * Whether sign-in accepts passkeys and security keys as a second factor
 * (`security.mfa.webauthnEnabled`, the code default when the settings read failed).
 */
export function passkeysAccepted(reading: MfaConfigReading): boolean {
  return reading.config.webauthnEnabled;
}

/**
 * The factors sign-in accepts for this account. Recovery codes have no switch.
 * When the settings read failed, a factor the code defaults switch off is left out
 * while the account has another usable one (fail closed), and kept while it is the
 * only one, since a failed read cannot tell what the admin chose.
 */
export function usableFactors(account: MfaFactorAccount, reading: MfaConfigReading): MfaFactor[] {
  const method: MfaFactor | null =
    account.mfaEnabled &&
    (account.mfaMethod === 'email' || account.mfaMethod === 'sms' || account.mfaMethod === 'totp')
      ? account.mfaMethod
      : null;
  const hasRecoveryCodes = (account.recoveryCodesRemaining ?? 0) > 0;
  const hasPasskeys = (account.passkeyCount ?? 0) > 0;
  let methodUsable = method != null && methodAccepted(method, reading);
  let passkeysUsable = hasPasskeys && passkeysAccepted(reading);
  if (reading.fallback && !hasRecoveryCodes) {
    if (method != null && !methodUsable && !passkeysUsable) methodUsable = true;
    if (hasPasskeys && !passkeysUsable && !methodUsable) passkeysUsable = true;
  }
  const factors: MfaFactor[] = [];
  if (methodUsable && method != null) factors.push(method);
  if (hasRecoveryCodes) factors.push('recovery_code');
  if (passkeysUsable) factors.push('passkey');
  return factors;
}

/**
 * The passkey counterpart of `mfaMethodGate`: passkeys switched off stop working at
 * sign-in while the account has another usable factor, and as the only factor they
 * are still accepted, and the user must enroll another one. `allowed` without passkeys.
 */
export function passkeyGate(account: MfaFactorAccount, reading: MfaConfigReading): MfaMethodGate {
  if ((account.passkeyCount ?? 0) === 0 || passkeysAccepted(reading)) return 'allowed';
  const usable = usableFactors(account, reading);
  if (usable.includes('passkey')) return 'allowed';
  return usable.length > 0 ? 'refused' : 'enrollment_required';
}

/** Whether the account has MFA: a primary method, or a passkey or security key. */
export function hasMfa(account: MfaFactorAccount): boolean {
  return (account.mfaEnabled && account.mfaMethod != null) || (account.passkeyCount ?? 0) > 0;
}

/**
 * A method an admin switched off stops working at sign-in while the account has another
 * usable factor. As the only factor it is still accepted, and the user must enroll another
 * one; when the settings read failed it is accepted as the only factor without enrollment.
 */
export function mfaMethodGate(account: MfaFactorAccount, reading: MfaConfigReading): MfaMethodGate {
  if (account.mfaMethod == null || methodAccepted(account.mfaMethod, reading)) return 'allowed';
  const usable = usableFactors(account, reading);
  if (usable.includes(account.mfaMethod as MfaFactor)) return 'allowed';
  return usable.length > 0 ? 'refused' : 'enrollment_required';
}

/** What the MFA step offers: the gate, the factors the challenge screen may use, and whether the primary method is switched off. */
export interface MfaSignInFactors {
  gate: MfaMethodGate;
  factors: MfaFactor[];
  methodDisabled: boolean;
}

export function mfaSignInFactors(
  account: MfaFactorAccount,
  reading: MfaConfigReading,
): MfaSignInFactors {
  const gate = mfaMethodGate(account, reading);
  const method = account.mfaMethod;
  const usable = usableFactors(account, reading);
  if (usable.length > 0) return { gate, factors: usable, methodDisabled: gate === 'refused' };
  // With no usable factor, switched-off factors are still accepted (enrollment follows).
  const factors: MfaFactor[] = [];
  if (account.mfaEnabled && (method === 'email' || method === 'sms' || method === 'totp')) {
    factors.push(method);
  }
  if ((account.passkeyCount ?? 0) > 0) factors.push('passkey');
  return { gate, factors, methodDisabled: false };
}
