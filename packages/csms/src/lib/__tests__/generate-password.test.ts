// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PASSWORD_POLICY,
  PASSWORD_MIN_LENGTH_CEILING,
  missingPasswordRules,
} from '@evtivity/lib/password-policy';
import { GENERATED_PASSWORD_CHARS, generateRandomPassword } from '../generate-password';

describe('generateRandomPassword', () => {
  it('draws from a set that divides 256, so every character is equally likely', () => {
    expect(new Set(GENERATED_PASSWORD_CHARS).size).toBe(GENERATED_PASSWORD_CHARS.length);
    expect(256 % GENERATED_PASSWORD_CHARS.length).toBe(0);
  });

  it('can draw every character class a policy requires', () => {
    const chars = Array.from(GENERATED_PASSWORD_CHARS);
    const strict = {
      minLength: PASSWORD_MIN_LENGTH_CEILING,
      requireUppercase: true,
      requireLowercase: true,
      requireNumber: true,
      requireSymbol: true,
    };
    for (const rule of ['uppercase', 'lowercase', 'number', 'symbol'] as const) {
      const reachable = chars.some(
        (char) => !missingPasswordRules(char.repeat(strict.minLength), strict).includes(rule),
      );
      expect(reachable, rule).toBe(true);
    }
  });

  it('meets the default policy with 16 characters', () => {
    for (let i = 0; i < 50; i++) {
      const password = generateRandomPassword(DEFAULT_PASSWORD_POLICY);
      expect(password).toHaveLength(16);
      expect(missingPasswordRules(password, DEFAULT_PASSWORD_POLICY)).toEqual([]);
    }
  });

  it('meets a strict policy: the configured length and a symbol', () => {
    const strict = {
      minLength: 24,
      requireUppercase: true,
      requireLowercase: true,
      requireNumber: true,
      requireSymbol: true,
    };
    for (let i = 0; i < 50; i++) {
      const password = generateRandomPassword(strict);
      expect(password).toHaveLength(24);
      expect(password).toMatch(/[^A-Za-z0-9\s]/);
      expect(missingPasswordRules(password, strict)).toEqual([]);
    }
  });

  it('reaches the longest minimum length a policy allows', () => {
    const policy = { ...DEFAULT_PASSWORD_POLICY, minLength: PASSWORD_MIN_LENGTH_CEILING };
    expect(generateRandomPassword(policy)).toHaveLength(PASSWORD_MIN_LENGTH_CEILING);
  });
});
