// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { missingPasswordRules, type PasswordPolicy } from '@evtivity/lib/password-policy';

// 64 characters without look-alikes (l, o, I, O, 0, 1): 256 is a multiple of 64, so a random byte
// maps to a character without bias.
export const GENERATED_PASSWORD_CHARS =
  'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*+';
const GENERATED_MIN_LENGTH = 16;

/** A random password of at least 16 characters, drawn until it meets every rule of the policy. */
export function generateRandomPassword(policy: PasswordPolicy): string {
  const length = Math.max(GENERATED_MIN_LENGTH, policy.minLength);
  for (;;) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    const password = Array.from(bytes, (b) =>
      GENERATED_PASSWORD_CHARS.charAt(b % GENERATED_PASSWORD_CHARS.length),
    ).join('');
    if (missingPasswordRules(password, policy).length === 0) return password;
  }
}
