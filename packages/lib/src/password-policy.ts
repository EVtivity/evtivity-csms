// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Password rules for operator users and drivers, as a function of the policy an admin sets in
 * Settings > Security. The API enforces them on every route that sets a password, and the CSMS,
 * portal and mobile app show them as a checklist under the password field. Browser-safe, so the
 * frontends import it via `@evtivity/lib/password-policy`.
 */

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
}

export const PASSWORD_MIN_LENGTH_FLOOR = 8;
export const PASSWORD_MIN_LENGTH_CEILING = 64;

/** Fixed, not a setting: length hygiene for new passwords. */
export const PASSWORD_MAX_LENGTH = 128;

export const DEFAULT_PASSWORD_POLICY: Readonly<PasswordPolicy> = Object.freeze({
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: false,
});

/** Every rule id in display and check order. Frontends translate them (`validation.passwordRule.*`). */
export const PASSWORD_RULE_IDS = [
  'minLength',
  'uppercase',
  'lowercase',
  'number',
  'symbol',
  'maxLength',
] as const;

export type PasswordRule = (typeof PASSWORD_RULE_IDS)[number];

/** A rule a policy can turn on (every rule but the fixed maximum length). */
export type PolicyRule = Exclude<PasswordRule, 'maxLength'>;

const OPTIONAL_RULES: readonly { rule: PolicyRule; key: keyof PasswordPolicy }[] = [
  { rule: 'uppercase', key: 'requireUppercase' },
  { rule: 'lowercase', key: 'requireLowercase' },
  { rule: 'number', key: 'requireNumber' },
  { rule: 'symbol', key: 'requireSymbol' },
];

// A symbol is a printable ASCII character that is not a letter, a digit or a space.
const RULE_CHECKS: Record<PasswordRule, (password: string, policy: PasswordPolicy) => boolean> = {
  minLength: (password, policy) => password.length >= policy.minLength,
  uppercase: (password) => /[A-Z]/.test(password),
  lowercase: (password) => /[a-z]/.test(password),
  number: (password) => /[0-9]/.test(password),
  symbol: (password) => /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(password),
  maxLength: (password) => password.length <= PASSWORD_MAX_LENGTH,
};

/** The rules the policy turns on, in display order. The minimum length always applies. */
export function activePasswordRules(policy: PasswordPolicy): PolicyRule[] {
  return [
    'minLength',
    ...OPTIONAL_RULES.filter(({ key }) => policy[key] === true).map(({ rule }) => rule),
  ];
}

export function passwordRuleResults(
  password: string,
  policy: PasswordPolicy,
): readonly { rule: PolicyRule; met: boolean }[] {
  return activePasswordRules(policy).map((rule) => ({
    rule,
    met: RULE_CHECKS[rule](password, policy),
  }));
}

/**
 * The rules the password does not meet, in display order, with `maxLength` last when the
 * password is longer than `PASSWORD_MAX_LENGTH`. Empty when the password is valid.
 */
export function missingPasswordRules(password: string, policy: PasswordPolicy): PasswordRule[] {
  const missing: PasswordRule[] = activePasswordRules(policy).filter(
    (rule) => !RULE_CHECKS[rule](password, policy),
  );
  if (!RULE_CHECKS.maxLength(password, policy)) missing.push('maxLength');
  return missing;
}

/**
 * A policy from stored values: a missing or mistyped field takes its default, and the minimum
 * length is truncated to an integer and clamped to the floor and ceiling.
 */
export function normalizePasswordPolicy(raw: Record<string, unknown>): PasswordPolicy {
  const bool = (key: keyof PasswordPolicy): boolean => {
    const value = raw[key];
    return typeof value === 'boolean' ? value : (DEFAULT_PASSWORD_POLICY[key] as boolean);
  };
  const rawMin = raw['minLength'];
  const minLength =
    typeof rawMin === 'number' && Number.isFinite(rawMin)
      ? Math.min(
          PASSWORD_MIN_LENGTH_CEILING,
          Math.max(PASSWORD_MIN_LENGTH_FLOOR, Math.trunc(rawMin)),
        )
      : DEFAULT_PASSWORD_POLICY.minLength;
  return {
    minLength,
    requireUppercase: bool('requireUppercase'),
    requireLowercase: bool('requireLowercase'),
    requireNumber: bool('requireNumber'),
    requireSymbol: bool('requireSymbol'),
  };
}
