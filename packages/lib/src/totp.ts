// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as OTPAuth from 'otpauth';

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function generateTotpUri(secret: string, email: string, issuer: string): string {
  const totp = new OTPAuth.TOTP({
    issuer,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return totp.toString();
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

/**
 * The TOTP time step a code matches (the current step, or one step either
 * side), or null when it matches none. A sign-in stores the step it accepted
 * and refuses that step and earlier ones, so an observed code cannot be
 * replayed.
 */
export function matchTotpStep(secret: string, code: string, nowMs = Date.now()): number | null {
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  const delta = totp.validate({ token: code, window: 1, timestamp: nowMs });
  if (delta === null) return null;
  return Math.floor(nowMs / 30_000) + delta;
}
