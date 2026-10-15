// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import argon2 from 'argon2';
import { verifyAgainstDummyHash } from './dummy-password-hash.js';

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Checks a password against a stored hash, for operators and drivers alike.
 * An account without a usable hash (null, empty for an SSO account, or not an
 * argon2 hash) answers false after the time of one real check, so the answer
 * and its timing never tell such an account apart. argon2 throws on a
 * malformed hash: that is logged at warn and answered false, never a 500.
 */
export async function verifyPassword(
  hash: string | null | undefined,
  password: string,
  log?: Logger,
): Promise<boolean> {
  if (hash == null || !hash.startsWith('$argon2')) {
    return verifyAgainstDummyHash(password);
  }
  try {
    return await argon2.verify(hash, password);
  } catch (err) {
    log?.warn({ err }, 'Stored password hash did not parse, answering a wrong password');
    return false;
  }
}
