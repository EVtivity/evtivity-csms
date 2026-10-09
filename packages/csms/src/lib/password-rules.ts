// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import {
  PASSWORD_MIN_LENGTH,
  missingPasswordRules,
  type PasswordRule,
} from '@evtivity/lib/password-policy';

export function passwordRuleLabel(rule: PasswordRule, t: TFunction): string {
  return t(`validation.passwordRule.${rule}`, { min: PASSWORD_MIN_LENGTH });
}

/**
 * The validation message naming every rule the password misses, or null when it meets them all.
 * The rules are the API's (`@evtivity/lib/password-policy`), so a WEAK_PASSWORD reply is
 * explained with the same message.
 */
export function passwordRulesMessage(
  password: string,
  t: TFunction,
  language: string,
): string | null {
  const missing = missingPasswordRules(password);
  if (missing.length === 0) return null;
  const labels = missing.map((rule) => passwordRuleLabel(rule, t));
  const rules = new Intl.ListFormat(language, { type: 'conjunction' }).format(labels);
  return t('validation.passwordMissing', { rules });
}
