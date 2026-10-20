// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PASSWORD_POLICY,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH_CEILING,
  PASSWORD_MIN_LENGTH_FLOOR,
  activePasswordRules,
  passwordRuleResults,
  missingPasswordRules,
  normalizePasswordPolicy,
} from '../password-policy.js';

describe('password policy', () => {
  it('defaults to 12 characters, an uppercase letter, a lowercase letter and a number', () => {
    expect(DEFAULT_PASSWORD_POLICY).toEqual({
      minLength: 12,
      requireUppercase: true,
      requireLowercase: true,
      requireNumber: true,
      requireSymbol: false,
    });
    expect(activePasswordRules(DEFAULT_PASSWORD_POLICY)).toEqual([
      'minLength',
      'uppercase',
      'lowercase',
      'number',
    ]);
  });

  it('has fixed bounds for the minimum and the maximum length', () => {
    expect(PASSWORD_MIN_LENGTH_FLOOR).toBe(8);
    expect(PASSWORD_MIN_LENGTH_CEILING).toBe(64);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });

  it('lists only the rules the policy turns on, minimum length always first', () => {
    expect(
      activePasswordRules({
        minLength: 8,
        requireUppercase: false,
        requireLowercase: true,
        requireNumber: false,
        requireSymbol: true,
      }),
    ).toEqual(['minLength', 'lowercase', 'symbol']);
  });

  it('accepts a password that meets every rule', () => {
    expect(missingPasswordRules('Abcdefghijk1', DEFAULT_PASSWORD_POLICY)).toEqual([]);
    expect(missingPasswordRules('P@ssw0rd!Long', DEFAULT_PASSWORD_POLICY)).toEqual([]);
  });

  it('reports every missing rule in display order', () => {
    expect(missingPasswordRules('', DEFAULT_PASSWORD_POLICY)).toEqual([
      'minLength',
      'uppercase',
      'lowercase',
      'number',
    ]);
    expect(missingPasswordRules('abcdefghijkl', DEFAULT_PASSWORD_POLICY)).toEqual([
      'uppercase',
      'number',
    ]);
    expect(missingPasswordRules('ABCDEFGHIJK1', DEFAULT_PASSWORD_POLICY)).toEqual(['lowercase']);
    expect(missingPasswordRules('Abc1', DEFAULT_PASSWORD_POLICY)).toEqual(['minLength']);
  });

  it('counts exactly the minimum as long enough and one less as too short', () => {
    expect(missingPasswordRules('Abcdefghij12', DEFAULT_PASSWORD_POLICY)).toEqual([]);
    expect(missingPasswordRules('Abcdefghi12', DEFAULT_PASSWORD_POLICY)).toEqual(['minLength']);
  });

  it('uses the configured minimum length', () => {
    const policy = { ...DEFAULT_PASSWORD_POLICY, minLength: 8 };
    expect(missingPasswordRules('Abc1', policy)).toEqual(['minLength']);
    expect(missingPasswordRules('Abcdef12', policy)).toEqual([]);
  });

  it('does not check a rule the policy turns off', () => {
    const policy = {
      ...DEFAULT_PASSWORD_POLICY,
      requireUppercase: false,
      requireLowercase: false,
      requireNumber: false,
    };
    expect(missingPasswordRules('............', policy)).toEqual([]);
  });

  it('checks a symbol only when required', () => {
    expect(missingPasswordRules('Abcdefghijk1', DEFAULT_PASSWORD_POLICY)).toEqual([]);
    const policy = { ...DEFAULT_PASSWORD_POLICY, requireSymbol: true };
    expect(missingPasswordRules('Abcdefghijk1', policy)).toEqual(['symbol']);
    expect(missingPasswordRules('Abcdefghij1!', policy)).toEqual([]);
    expect(missingPasswordRules('Abcdefghij1 x', policy)).toEqual(['symbol']);
  });

  it('counts printable ASCII punctuation as a symbol and nothing else', () => {
    const policy = { ...DEFAULT_PASSWORD_POLICY, requireSymbol: true };
    for (const symbol of ['!', '~', '`', '/', ':', '@', '[', '{']) {
      expect(missingPasswordRules(`Abcdefghij1${symbol}`, policy)).toEqual([]);
    }
    for (const other of ['é', '密', '\t', '\u00a0', '\u00a7']) {
      expect(missingPasswordRules(`Abcdefghij1${other}`, policy)).toEqual(['symbol']);
    }
    const symbols = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)).filter(
      (char) => missingPasswordRules(`Abcdefghij1${char}`, policy).length === 0,
    );
    expect(symbols.join('')).toBe('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
  });

  it('does not count non-ASCII letters as uppercase or lowercase', () => {
    expect(missingPasswordRules('ÄÖÜäöüßéèàç1', DEFAULT_PASSWORD_POLICY)).toEqual([
      'uppercase',
      'lowercase',
    ]);
  });

  it('refuses anything over the fixed maximum and accepts the maximum itself', () => {
    expect(
      missingPasswordRules(`Aa1${'x'.repeat(PASSWORD_MAX_LENGTH)}`, DEFAULT_PASSWORD_POLICY),
    ).toEqual(['maxLength']);
    expect(
      missingPasswordRules(`Aa1${'x'.repeat(PASSWORD_MAX_LENGTH - 3)}`, DEFAULT_PASSWORD_POLICY),
    ).toEqual([]);
  });

  it('returns a met flag per active rule', () => {
    expect(passwordRuleResults('abc', DEFAULT_PASSWORD_POLICY)).toEqual([
      { rule: 'minLength', met: false },
      { rule: 'uppercase', met: false },
      { rule: 'lowercase', met: true },
      { rule: 'number', met: false },
    ]);
    expect(
      passwordRuleResults('abc!', { ...DEFAULT_PASSWORD_POLICY, requireSymbol: true }).at(-1),
    ).toEqual({ rule: 'symbol', met: true });
  });

  it('normalizes stored values into range and falls back per field', () => {
    expect(normalizePasswordPolicy({ minLength: 4, requireSymbol: 'yes' })).toEqual({
      ...DEFAULT_PASSWORD_POLICY,
      minLength: 8,
    });
    expect(normalizePasswordPolicy({ minLength: 200 }).minLength).toBe(64);
    expect(normalizePasswordPolicy({ minLength: 10.6 }).minLength).toBe(10);
    expect(normalizePasswordPolicy({ minLength: '10' }).minLength).toBe(12);
    expect(normalizePasswordPolicy({ minLength: Number.NaN }).minLength).toBe(12);
    expect(normalizePasswordPolicy({})).toEqual(DEFAULT_PASSWORD_POLICY);
    expect(
      normalizePasswordPolicy({
        minLength: 16,
        requireUppercase: false,
        requireLowercase: false,
        requireNumber: false,
        requireSymbol: true,
      }),
    ).toEqual({
      minLength: 16,
      requireUppercase: false,
      requireLowercase: false,
      requireNumber: false,
      requireSymbol: true,
    });
  });
});
