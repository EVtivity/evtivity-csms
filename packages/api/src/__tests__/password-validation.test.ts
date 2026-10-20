// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_PASSWORD_POLICY } from '@evtivity/lib/password-policy';

vi.mock('@evtivity/database', () => ({ getPasswordPolicy: vi.fn() }));

import { getPasswordPolicy } from '@evtivity/database';
import { WeakPasswordError, assertPassword, validatePassword } from '../lib/password-validation.js';

describe('validatePassword', () => {
  beforeEach(() => {
    vi.mocked(getPasswordPolicy).mockResolvedValue({ ...DEFAULT_PASSWORD_POLICY });
  });

  it('returns null for a password that meets the policy', async () => {
    expect(await validatePassword('Abcdefghij12')).toBeNull();
    expect(await validatePassword('P@ssw0rd!Long')).toBeNull();
  });

  it('names a single missing character class', async () => {
    expect(await validatePassword('abcdefghij12')).toEqual({
      error: 'Password must contain an uppercase letter',
      code: 'WEAK_PASSWORD',
      missing: ['uppercase'],
    });
    expect((await validatePassword('ABCDEFGHIJ12'))?.error).toBe(
      'Password must contain a lowercase letter',
    );
    expect((await validatePassword('Abcdefghijkl'))?.error).toBe('Password must contain a number');
  });

  it('names every missing character class in rule order', async () => {
    expect(await validatePassword('!!!!!!!!!!!!')).toEqual({
      error: 'Password must contain an uppercase letter, a lowercase letter and a number',
      code: 'WEAK_PASSWORD',
      missing: ['uppercase', 'lowercase', 'number'],
    });
  });

  it('takes the minimum length from the policy, not the schema', async () => {
    expect(await validatePassword('Abcdefghi12')).toEqual({
      error: 'Password must be at least 12 characters',
      code: 'WEAK_PASSWORD',
      missing: ['minLength'],
    });
    vi.mocked(getPasswordPolicy).mockResolvedValue({ ...DEFAULT_PASSWORD_POLICY, minLength: 10 });
    expect(await validatePassword('Abcdefgh12')).toBeNull();
  });

  it('reports the length and a symbol when the policy requires them', async () => {
    vi.mocked(getPasswordPolicy).mockResolvedValue({
      ...DEFAULT_PASSWORD_POLICY,
      minLength: 16,
      requireSymbol: true,
    });
    expect(await validatePassword('Abcdefghij12')).toEqual({
      error: 'Password must be at least 16 characters and contain a special character',
      code: 'WEAK_PASSWORD',
      missing: ['minLength', 'symbol'],
    });
    expect(await validatePassword('Abcdefghij12!xyz')).toBeNull();
  });

  it('refuses a password longer than the fixed maximum', async () => {
    expect(await validatePassword(`Aa1${'x'.repeat(126)}`)).toEqual({
      error: 'Password must be at most 128 characters',
      code: 'WEAK_PASSWORD',
      missing: ['maxLength'],
    });
  });

  it('checks nothing beyond the length when the policy turns every class off', async () => {
    vi.mocked(getPasswordPolicy).mockResolvedValue({
      minLength: 8,
      requireUppercase: false,
      requireLowercase: false,
      requireNumber: false,
      requireSymbol: false,
    });
    expect(await validatePassword('aaaaaaaa')).toBeNull();
  });
});

describe('assertPassword', () => {
  beforeEach(() => {
    vi.mocked(getPasswordPolicy).mockResolvedValue({ ...DEFAULT_PASSWORD_POLICY });
  });

  it('resolves for a valid password', async () => {
    await expect(assertPassword('Abcdefghij12')).resolves.toBeUndefined();
  });

  it('throws a 400 WEAK_PASSWORD error that carries the missing rules', async () => {
    const err = await assertPassword('abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WeakPasswordError);
    expect(err).toMatchObject({
      statusCode: 400,
      code: 'WEAK_PASSWORD',
      missing: ['minLength', 'uppercase', 'number'],
    });
  });
});
