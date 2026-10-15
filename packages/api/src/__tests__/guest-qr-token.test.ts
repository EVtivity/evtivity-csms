// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  GUEST_QR_TOKEN_TTL_SECONDS,
  signGuestQrToken,
  verifyGuestQrToken,
} from '../lib/guest-qr-token.js';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const TARGET = { stationId: 'CS-001', evseId: 1 };

describe('guest QR scan token', () => {
  it('verifies a token for the EVSE it was issued for', () => {
    const { token, expiresAt } = signGuestQrToken(TARGET, NOW);
    expect(token).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+$/);
    expect(expiresAt.getTime()).toBe(NOW + GUEST_QR_TOKEN_TTL_SECONDS * 1000);
    expect(verifyGuestQrToken(token, TARGET, NOW + 60_000)).toBe(true);
  });

  it('expires after the TTL', () => {
    const { token } = signGuestQrToken(TARGET, NOW);
    expect(verifyGuestQrToken(token, TARGET, NOW + GUEST_QR_TOKEN_TTL_SECONDS * 1000)).toBe(false);
  });

  it('refuses another EVSE or station', () => {
    const { token } = signGuestQrToken(TARGET, NOW);
    expect(verifyGuestQrToken(token, { stationId: 'CS-001', evseId: 2 }, NOW)).toBe(false);
    expect(verifyGuestQrToken(token, { stationId: 'CS-002', evseId: 1 }, NOW)).toBe(false);
  });

  it('refuses a token with an extended expiry', () => {
    const { token } = signGuestQrToken(TARGET, NOW);
    const [version, expiry, signature] = token.split('.');
    const forged = `${version ?? ''}.${String(Number(expiry) + 3600)}.${signature ?? ''}`;
    expect(verifyGuestQrToken(forged, TARGET, NOW)).toBe(false);
  });

  it('refuses missing and malformed tokens', () => {
    expect(verifyGuestQrToken(undefined, TARGET, NOW)).toBe(false);
    expect(verifyGuestQrToken('', TARGET, NOW)).toBe(false);
    expect(verifyGuestQrToken('v1.abc.def', TARGET, NOW)).toBe(false);
    expect(verifyGuestQrToken('v2.1.abc', TARGET, NOW)).toBe(false);
    expect(verifyGuestQrToken('not-a-token', TARGET, NOW)).toBe(false);
  });
});
