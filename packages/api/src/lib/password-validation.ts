// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { getPasswordPolicy } from '@evtivity/database';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH_FLOOR,
  PASSWORD_RULE_IDS,
  missingPasswordRules,
  type PasswordPolicy,
  type PasswordRule,
} from '@evtivity/lib/password-policy';

type ClassRule = Exclude<PasswordRule, 'minLength' | 'maxLength'>;

const CLASS_TEXT: Record<ClassRule, string> = {
  uppercase: 'an uppercase letter',
  lowercase: 'a lowercase letter',
  number: 'a number',
  symbol: 'a special character',
};

export interface WeakPassword {
  error: string;
  code: 'WEAK_PASSWORD';
  missing: PasswordRule[];
}

/**
 * A request field that sets a new password. The schema bounds it to the policy floor and the
 * fixed maximum; `validatePassword` then checks the live policy.
 */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH_FLOOR)
  .max(PASSWORD_MAX_LENGTH)
  .describe(
    'Checked against the password policy in Settings > Security (8 to 64 characters, default 12), at most 128 characters',
  );

/** The `missing` field of a 400 WEAK_PASSWORD response. */
export const weakPasswordFields = {
  missing: z
    .array(z.enum(PASSWORD_RULE_IDS))
    .optional()
    .describe(
      'With WEAK_PASSWORD: the password rules the password does not meet (minLength, uppercase, lowercase, number, symbol, maxLength)',
    ),
};

/**
 * A 400 WEAK_PASSWORD whose response body also carries the missing rules. The app error handler
 * answers it; it does not extend AppError so route tests that mock `@evtivity/lib` still load it.
 */
export class WeakPasswordError extends Error {
  public readonly statusCode = 400;
  public readonly code = 'WEAK_PASSWORD';
  public readonly missing: PasswordRule[];

  constructor(weak: WeakPassword) {
    super(weak.error);
    this.name = 'WeakPasswordError';
    this.missing = weak.missing;
  }
}

function joinList(items: string[]): string {
  const last = items.at(-1) ?? '';
  return items.length <= 1 ? last : `${items.slice(0, -1).join(', ')} and ${last}`;
}

function weakPasswordMessage(missing: PasswordRule[], policy: PasswordPolicy): string {
  const parts: string[] = [];
  if (missing.includes('minLength'))
    parts.push(`be at least ${String(policy.minLength)} characters`);
  if (missing.includes('maxLength'))
    parts.push(`be at most ${String(PASSWORD_MAX_LENGTH)} characters`);
  const classes = missing
    .filter((rule): rule is ClassRule => rule in CLASS_TEXT)
    .map((rule) => CLASS_TEXT[rule]);
  if (classes.length > 0) parts.push(`contain ${joinList(classes)}`);
  return `Password must ${parts.join(' and ')}`;
}

/**
 * Checks a new password against the live policy (Settings > Security). The route schemas only
 * bound the length to the fixed floor and maximum, so the configured minimum is checked here.
 * Returns the 400 WEAK_PASSWORD body naming every missing rule, or null when the password is valid.
 */
export async function validatePassword(password: string): Promise<WeakPassword | null> {
  const policy = await getPasswordPolicy();
  const missing = missingPasswordRules(password, policy);
  if (missing.length === 0) return null;
  return { error: weakPasswordMessage(missing, policy), code: 'WEAK_PASSWORD', missing };
}

/** Like `validatePassword`, for services: throws a `WeakPasswordError`. */
export async function assertPassword(password: string): Promise<void> {
  const weak = await validatePassword(password);
  if (weak != null) throw new WeakPasswordError(weak);
}
