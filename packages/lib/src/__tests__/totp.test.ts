// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import * as OTPAuth from 'otpauth';
import { generateTotpSecret, generateTotpUri, verifyTotpCode } from '../totp.js';

describe('generateTotpSecret', () => {
  it('returns a non-empty base32 string', () => {
    const secret = generateTotpSecret();
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThan(0);
    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  it('round-trips through OTPAuth.Secret.fromBase32 to a 20-byte buffer', () => {
    const secret = generateTotpSecret();
    const parsed = OTPAuth.Secret.fromBase32(secret);
    expect(parsed.bytes.length).toBe(20);
    expect(parsed.base32).toBe(secret);
  });

  it('produces a unique secret on each call', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(50);
  });
});

describe('generateTotpUri', () => {
  const secret = generateTotpSecret();

  it('returns a valid otpauth:// TOTP URI', () => {
    const uri = generateTotpUri(secret, 'driver@example.com', 'EVtivity');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
  });

  it('encodes the issuer, label, and secret', () => {
    const uri = generateTotpUri(secret, 'driver@example.com', 'EVtivity');
    const parsed = new URL(uri);
    expect(parsed.searchParams.get('issuer')).toBe('EVtivity');
    expect(parsed.searchParams.get('secret')).toBe(secret);
    expect(decodeURIComponent(parsed.pathname)).toContain('driver@example.com');
  });

  it('sets SHA1, 6 digits, and 30s period', () => {
    const uri = generateTotpUri(secret, 'driver@example.com', 'EVtivity');
    const parsed = new URL(uri);
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
  });

  it('parses back into an equivalent OTPAuth.TOTP whose code verifies', () => {
    const uri = generateTotpUri(secret, 'driver@example.com', 'EVtivity');
    const totp = OTPAuth.URI.parse(uri) as OTPAuth.TOTP;
    const code = totp.generate();
    expect(verifyTotpCode(secret, code)).toBe(true);
  });

  it('escapes special characters in the label and issuer', () => {
    const uri = generateTotpUri(secret, 'a b@example.com', 'EV tivity');
    const parsed = new URL(uri);
    expect(parsed.searchParams.get('issuer')).toBe('EV tivity');
    expect(decodeURIComponent(parsed.pathname)).toContain('a b@example.com');
  });
});

describe('verifyTotpCode', () => {
  function currentCode(secret: string, timestampMs?: number): string {
    const totp = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    return timestampMs == null ? totp.generate() : totp.generate({ timestamp: timestampMs });
  }

  it('accepts the current valid code', () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, currentCode(secret))).toBe(true);
  });

  it('rejects an incorrect code', () => {
    const secret = generateTotpSecret();
    const valid = currentCode(secret);
    const wrong = valid === '000000' ? '111111' : '000000';
    expect(verifyTotpCode(secret, wrong)).toBe(false);
  });

  it('rejects a non-numeric or malformed code', () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, 'abcdef')).toBe(false);
    expect(verifyTotpCode(secret, '')).toBe(false);
    expect(verifyTotpCode(secret, '12345')).toBe(false);
  });

  it('accepts a code from the previous 30s window (window tolerance)', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const prev = currentCode(secret, now - 30_000);
    expect(verifyTotpCode(secret, prev)).toBe(true);
  });

  it('rejects a code from two windows ago (outside window=1)', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const current = currentCode(secret, now);
    const twoBack = currentCode(secret, now - 90_000);
    // Skip if the codes happen to coincide (rare collision), otherwise assert rejection.
    if (twoBack !== current) {
      expect(verifyTotpCode(secret, twoBack)).toBe(false);
    } else {
      expect(verifyTotpCode(secret, current)).toBe(true);
    }
  });

  it('rejects a code generated from a different secret', () => {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const codeForB = currentCode(secretB);
    const codeForA = currentCode(secretA);
    // Only assert mismatch when the two secrets produce different codes this window.
    if (codeForA !== codeForB) {
      expect(verifyTotpCode(secretA, codeForB)).toBe(false);
    } else {
      expect(verifyTotpCode(secretA, codeForA)).toBe(true);
    }
  });
});
