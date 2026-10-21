// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import type { MfaAccount } from '../services/mfa-factor.service.js';
import { verifyPassword } from './password-verify.js';
import {
  clearSignInFailures,
  isLocked,
  recordAttemptFailure,
  takeSignInAttempt,
} from './sign-in-backoff.js';

/**
 * Checks the current password a signed-in operator or driver sends to change
 * the password or turn MFA off. A wrong one counts toward the account's
 * password backoff, as at sign-in, so a stolen session cannot guess it; while
 * the account is locked the password is refused without a check.
 */
export async function checkCurrentPassword(
  request: FastifyRequest,
  account: MfaAccount,
  stored: { passwordHash: string | null; loginLockedUntil: Date | null },
  password: string,
): Promise<boolean> {
  if (isLocked(stored.loginLockedUntil)) return false;
  // The try is counted in the UPDATE that checks the lock, so parallel guesses cannot pass it.
  const attempt = await takeSignInAttempt(account, 'password');
  if (!attempt.granted) return false;
  if (await verifyPassword(stored.passwordHash, password, request.log)) {
    await clearSignInFailures(account, 'password');
    return true;
  }
  await recordAttemptFailure(request, attempt);
  return false;
}
