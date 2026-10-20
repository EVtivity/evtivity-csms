// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_RULE_IDS,
  missingPasswordRules,
  passwordRuleResults,
  type PasswordPolicy,
  type PasswordRule,
} from '@evtivity/lib/password-policy';
import { ApiError } from '@/lib/api';

export function passwordRuleLabel(
  rule: PasswordRule,
  policy: PasswordPolicy,
  t: TFunction,
): string {
  return t(`validation.passwordRule.${rule}`, {
    min: policy.minLength,
    max: PASSWORD_MAX_LENGTH,
  });
}

function inRuleOrder(rules: Iterable<PasswordRule>): PasswordRule[] {
  const set = new Set(rules);
  return PASSWORD_RULE_IDS.filter((rule) => set.has(rule));
}

/**
 * The rules a WEAK_PASSWORD reply names, or null for any other error. The API can hold a newer
 * policy than the one this page loaded, so its list wins over the local check.
 */
export function weakPasswordMissing(err: unknown): PasswordRule[] | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return null;
  const { code, missing } = body as { code?: unknown; missing?: unknown };
  if (code !== 'WEAK_PASSWORD') return null;
  if (!Array.isArray(missing)) return [];
  const known = new Set<string>(PASSWORD_RULE_IDS);
  return inRuleOrder(
    missing.filter((rule): rule is PasswordRule => typeof rule === 'string' && known.has(rule)),
  );
}

/**
 * The checklist under a new password field: the rules of the policy, the maximum length only once
 * the password exceeds it, and every rule a WEAK_PASSWORD reply named, marked unmet.
 */
export function passwordChecklist(
  password: string,
  policy: PasswordPolicy,
  serverMissing?: readonly PasswordRule[] | null,
): { rule: PasswordRule; met: boolean }[] {
  const refused = new Set(serverMissing ?? []);
  const results = new Map<PasswordRule, boolean>(
    passwordRuleResults(password, policy).map(({ rule, met }) => [rule, met && !refused.has(rule)]),
  );
  if (missingPasswordRules(password, policy).includes('maxLength')) results.set('maxLength', false);
  for (const rule of refused) results.set(rule, false);
  return inRuleOrder(results.keys()).map((rule) => ({ rule, met: results.get(rule) === true }));
}

/**
 * The validation message naming every rule the password misses, or null when it meets them all.
 * The rules are the API's (`@evtivity/lib/password-policy`); `serverMissing` adds the rules a
 * WEAK_PASSWORD reply named. An empty reply list falls back to the generic WEAK_PASSWORD text.
 */
export function passwordRulesMessage(
  password: string,
  policy: PasswordPolicy,
  t: TFunction,
  language: string,
  serverMissing?: readonly PasswordRule[] | null,
): string | null {
  const missing = inRuleOrder([
    ...missingPasswordRules(password, policy),
    ...(serverMissing ?? []),
  ]);
  if (missing.length === 0) return serverMissing != null ? t('errors.WEAK_PASSWORD') : null;
  const labels = missing.map((rule) => passwordRuleLabel(rule, policy, t));
  const rules = new Intl.ListFormat(language, { type: 'conjunction' }).format(labels);
  return t('validation.passwordMissing', { rules });
}
