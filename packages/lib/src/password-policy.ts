// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Password rules for operator users and drivers. The API enforces them on every route that
 * sets a password, and the CSMS and portal show them as a checklist under the password field.
 * Browser-safe, so the frontends import it via `@evtivity/lib/password-policy`.
 */

export const PASSWORD_MIN_LENGTH = 12;

/** Rule ids in display and check order. Frontends translate them (`validation.passwordRule.*`). */
export const PASSWORD_RULES = ['minLength', 'uppercase', 'lowercase', 'number'] as const;

export type PasswordRule = (typeof PASSWORD_RULES)[number];

const RULE_CHECKS: Record<PasswordRule, (password: string) => boolean> = {
  minLength: (password) => password.length >= PASSWORD_MIN_LENGTH,
  uppercase: (password) => /[A-Z]/.test(password),
  lowercase: (password) => /[a-z]/.test(password),
  number: (password) => /[0-9]/.test(password),
};

export function passwordRuleResults(
  password: string,
): readonly { rule: PasswordRule; met: boolean }[] {
  return PASSWORD_RULES.map((rule) => ({ rule, met: RULE_CHECKS[rule](password) }));
}

/** The rules the password does not meet, in display order. Empty when the password is valid. */
export function missingPasswordRules(password: string): PasswordRule[] {
  return PASSWORD_RULES.filter((rule) => !RULE_CHECKS[rule](password));
}
