// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet, mockExecuteRecaptcha } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockExecuteRecaptcha: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: { get: mockGet } }));
vi.mock('@/lib/recaptcha', () => ({ executeRecaptcha: mockExecuteRecaptcha }));

import { guestStartExtras, readGuestQrToken, storeGuestQrToken } from '../guest-start';

beforeEach(() => {
  sessionStorage.clear();
  mockGet.mockReset();
  mockExecuteRecaptcha.mockReset();
});

describe('guest start extras', () => {
  it('keeps the QR scan token per station and EVSE', () => {
    storeGuestQrToken('CS-1', 1, 'v1.123.abc');
    expect(readGuestQrToken('CS-1', '1')).toBe('v1.123.abc');
    expect(readGuestQrToken('CS-1', '2')).toBeUndefined();
  });

  it('sends the language, the scan token and a reCAPTCHA token when reCAPTCHA is on', async () => {
    storeGuestQrToken('CS-1', 1, 'v1.123.abc');
    mockGet.mockResolvedValue({ recaptchaEnabled: true, recaptchaSiteKey: 'site-key' });
    mockExecuteRecaptcha.mockResolvedValue('rc-token');

    await expect(guestStartExtras('CS-1', '1', 'de')).resolves.toEqual({
      language: 'de',
      qrToken: 'v1.123.abc',
      recaptchaToken: 'rc-token',
    });
    expect(mockGet).toHaveBeenCalledWith('/v1/security/public');
    expect(mockExecuteRecaptcha).toHaveBeenCalledWith('site-key', 'guest_start');
  });

  it('sends only the language at a station without a scan and reCAPTCHA off', async () => {
    mockGet.mockResolvedValue({ recaptchaEnabled: false, recaptchaSiteKey: '' });

    await expect(guestStartExtras('CS-9', '1', 'en')).resolves.toEqual({ language: 'en' });
    expect(mockExecuteRecaptcha).not.toHaveBeenCalled();
  });
});
