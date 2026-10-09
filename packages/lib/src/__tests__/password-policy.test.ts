// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
  passwordRuleResults,
  missingPasswordRules,
} from '../password-policy.js';

describe('password policy', () => {
  it('requires 12 characters, an uppercase letter, a lowercase letter and a number', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_RULES).toEqual(['minLength', 'uppercase', 'lowercase', 'number']);
  });

  it('accepts a password that meets every rule', () => {
    expect(missingPasswordRules('Abcdefghijk1')).toEqual([]);
    expect(missingPasswordRules('P@ssw0rd!Long')).toEqual([]);
  });

  it('reports every missing rule in display order', () => {
    expect(missingPasswordRules('')).toEqual(['minLength', 'uppercase', 'lowercase', 'number']);
    expect(missingPasswordRules('abcdefghijkl')).toEqual(['uppercase', 'number']);
    expect(missingPasswordRules('ABCDEFGHIJK1')).toEqual(['lowercase']);
    expect(missingPasswordRules('Abc1')).toEqual(['minLength']);
  });

  it('counts exactly 12 characters as long enough and 11 as too short', () => {
    expect(missingPasswordRules('Abcdefghij12')).toEqual([]);
    expect(missingPasswordRules('Abcdefghi12')).toEqual(['minLength']);
  });

  it('does not count non-ASCII letters as uppercase or lowercase', () => {
    expect(missingPasswordRules('ÄÖÜäöüßéèàç1')).toEqual(['uppercase', 'lowercase']);
  });

  it('returns a met flag per rule', () => {
    expect(passwordRuleResults('abc')).toEqual([
      { rule: 'minLength', met: false },
      { rule: 'uppercase', met: false },
      { rule: 'lowercase', met: true },
      { rule: 'number', met: false },
    ]);
  });
});
