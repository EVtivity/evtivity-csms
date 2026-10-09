// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { validatePasswordComplexity } from '../lib/password-validation.js';

describe('validatePasswordComplexity', () => {
  it('returns null for a password with upper, lower, and a digit', () => {
    expect(validatePasswordComplexity('Abcdef1')).toBeNull();
  });

  it('returns the uppercase error when no uppercase letter is present', () => {
    expect(validatePasswordComplexity('abcdef1')).toBe('Password must contain an uppercase letter');
  });

  it('returns the lowercase error when no lowercase letter is present', () => {
    expect(validatePasswordComplexity('ABCDEF1')).toBe('Password must contain a lowercase letter');
  });

  it('returns the number error when no digit is present', () => {
    expect(validatePasswordComplexity('Abcdefg')).toBe('Password must contain a number');
  });

  it('names every missing character class in rule order', () => {
    expect(validatePasswordComplexity('!!!!!!!')).toBe(
      'Password must contain an uppercase letter, a lowercase letter and a number',
    );
    expect(validatePasswordComplexity('abcdefghijkl')).toBe(
      'Password must contain an uppercase letter and a number',
    );
  });

  it('leaves the length to the Zod schema', () => {
    expect(validatePasswordComplexity('Ab1')).toBeNull();
  });

  it('accepts complex passwords with symbols', () => {
    expect(validatePasswordComplexity('P@ssw0rd!')).toBeNull();
  });
});
