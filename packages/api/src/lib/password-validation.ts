// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { missingPasswordRules, type PasswordRule } from '@evtivity/lib/password-policy';

const RULE_TEXT: Record<Exclude<PasswordRule, 'minLength'>, string> = {
  uppercase: 'an uppercase letter',
  lowercase: 'a lowercase letter',
  number: 'a number',
};

/**
 * Validate password complexity beyond minimum length, with the shared rules of
 * `@evtivity/lib/password-policy` (the CSMS and portal check the same rules as the driver types).
 * Zod .regex() refines do not translate to JSON Schema for Fastify AJV validation,
 * so length is enforced in the Zod schema (`PASSWORD_MIN_LENGTH`) and complexity is checked here.
 *
 * Returns an error message naming every missing character class, or null if the password is valid.
 */
export function validatePasswordComplexity(password: string): string | null {
  const missing = missingPasswordRules(password)
    .filter((rule): rule is Exclude<PasswordRule, 'minLength'> => rule !== 'minLength')
    .map((rule) => RULE_TEXT[rule]);
  if (missing.length === 0) return null;
  const last = missing.pop() ?? '';
  const list = missing.length === 0 ? last : `${missing.join(', ')} and ${last}`;
  return `Password must contain ${list}`;
}
