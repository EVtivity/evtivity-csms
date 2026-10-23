// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { createHmac, hkdfSync } from 'node:crypto';
import { deriveKey, KEY_LABELS } from '../derived-keys.js';

describe('deriveKey', () => {
  it('derives one stable 32-byte key per label, never the secret itself', () => {
    const secret = 'a-jwt-secret-of-at-least-thirty-two-chars';
    const cookies = deriveKey(secret, KEY_LABELS.cookies);
    expect(cookies).toHaveLength(32);
    expect(deriveKey(secret, KEY_LABELS.cookies).equals(cookies)).toBe(true);
    expect(deriveKey(secret, KEY_LABELS.guestQr).equals(cookies)).toBe(false);
    expect(cookies.toString('utf8')).not.toContain(secret);
  });

  it('keeps every label distinct', () => {
    const labels = Object.values(KEY_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('derives the keys stored values were signed with (empty salt)', () => {
    const secret = 'settings-key-of-at-least-thirty-two-chars';
    for (const label of Object.values(KEY_LABELS)) {
      const expected = Buffer.from(hkdfSync('sha256', secret, '', label, 32));
      expect(deriveKey(secret, label).equals(expected), label).toBe(true);
    }
    expect(createHmac('sha256', deriveKey(secret, KEY_LABELS.simulatedWebhook)).digest('hex')).toBe(
      createHmac(
        'sha256',
        Buffer.from(hkdfSync('sha256', secret, '', 'simulated-webhook', 32)),
      ).digest('hex'),
    );
  });
});
