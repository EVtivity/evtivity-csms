// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** Who must have MFA at operator sign-in: nobody, every operator, or the listed roles. */
export const MFA_REQUIRED_MODES = ['off', 'all', 'roles'] as const;
export type MfaRequiredMode = (typeof MFA_REQUIRED_MODES)[number];

/** The admin switches for each MFA method and the required MFA rule (security.mfa.* settings). */
export interface MfaConfig {
  emailEnabled: boolean;
  totpEnabled: boolean;
  smsEnabled: boolean;
  required: MfaRequiredMode;
  /** Role names that must have MFA when `required` is `roles`. */
  requiredRoles: string[];
  /** Passkeys and security keys (WebAuthn) as a second factor. */
  webauthnEnabled: boolean;
  /** Passwordless sign-in with a passkey (user verification required). */
  passkeyLoginEnabled: boolean;
  /** Every driver must have MFA at portal sign-in. */
  requireDrivers: boolean;
}

/**
 * Email, TOTP and WebAuthn are on until an admin switches them off; SMS needs Twilio, so it
 * starts off. Passkey sign-in skips the password, so it starts off too, and nobody
 * has to enroll until an admin requires MFA.
 */
export const DEFAULT_MFA_CONFIG: Readonly<MfaConfig> = Object.freeze({
  emailEnabled: true,
  totpEnabled: true,
  smsEnabled: false,
  required: 'off',
  requiredRoles: [],
  webauthnEnabled: true,
  passkeyLoginEnabled: false,
  requireDrivers: false,
});

export function isMfaRequiredMode(value: unknown): value is MfaRequiredMode {
  return typeof value === 'string' && (MFA_REQUIRED_MODES as readonly string[]).includes(value);
}

/** The stored role list as unique, trimmed, non-empty names; anything else is an empty list. */
export function normalizeMfaRequiredRoles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name !== '') names.add(name);
  }
  return [...names];
}

/** The switches in effect, from the stored security.mfa.* values without their prefix. */
export function normalizeMfaConfig(raw: Record<string, unknown>): MfaConfig {
  return {
    emailEnabled: raw['emailEnabled'] !== false,
    totpEnabled: raw['totpEnabled'] !== false,
    smsEnabled: raw['smsEnabled'] === true,
    required: isMfaRequiredMode(raw['required']) ? raw['required'] : 'off',
    requiredRoles: normalizeMfaRequiredRoles(raw['requiredRoles']),
    webauthnEnabled: raw['webauthnEnabled'] !== false,
    passkeyLoginEnabled: raw['passkeyLoginEnabled'] === true,
    requireDrivers: raw['requireDrivers'] === true,
  };
}

/** Whether an operator of this role must have MFA. */
export function isMfaRequiredForRole(
  config: Pick<MfaConfig, 'required' | 'requiredRoles'>,
  roleName: string | null,
): boolean {
  if (config.required === 'all') return true;
  if (config.required !== 'roles') return false;
  return roleName != null && config.requiredRoles.includes(roleName);
}
