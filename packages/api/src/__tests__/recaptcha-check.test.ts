// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply } from 'fastify';

const { getRecaptchaConfigMock, decryptStringMock, verifyRecaptchaMock } = vi.hoisted(() => ({
  getRecaptchaConfigMock: vi.fn(),
  decryptStringMock: vi.fn(),
  verifyRecaptchaMock: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  getRecaptchaConfig: getRecaptchaConfigMock,
}));

vi.mock('@evtivity/lib', () => ({
  decryptSettingOrNull: (stored: unknown, passphrase: string) =>
    typeof stored === 'string' && stored !== ''
      ? (decryptStringMock(stored, passphrase) as string)
      : null,
  verifyRecaptcha: verifyRecaptchaMock,
}));

vi.mock('../lib/config.js', () => ({
  config: { SETTINGS_ENCRYPTION_KEY: 'test-key' },
}));

import { checkRecaptcha } from '../lib/recaptcha-check.js';

function makeReply(): {
  reply: FastifyReply;
  send: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => undefined);
  const status = vi.fn(() => ({ send }));
  const reply = { status } as unknown as FastifyReply;
  return { reply, send, status };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkRecaptcha', () => {
  it('returns true without sending when reCAPTCHA is disabled (config null)', async () => {
    getRecaptchaConfigMock.mockResolvedValue(null);
    const { reply, status } = makeReply();

    const result = await checkRecaptcha('any-token', reply);

    expect(result).toBe(true);
    expect(status).not.toHaveBeenCalled();
    expect(verifyRecaptchaMock).not.toHaveBeenCalled();
  });

  it('returns false with 400 RECAPTCHA_REQUIRED when token is undefined', async () => {
    getRecaptchaConfigMock.mockResolvedValue({ secretKeyEnc: 'enc', threshold: 0.5 });
    const { reply, send, status } = makeReply();

    const result = await checkRecaptcha(undefined, reply);

    expect(result).toBe(false);
    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({
      error: 'reCAPTCHA token is required',
      code: 'RECAPTCHA_REQUIRED',
    });
  });

  it('returns false with 400 RECAPTCHA_REQUIRED when token is an empty string', async () => {
    getRecaptchaConfigMock.mockResolvedValue({ secretKeyEnc: 'enc', threshold: 0.5 });
    const { reply, send, status } = makeReply();

    const result = await checkRecaptcha('', reply);

    expect(result).toBe(false);
    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({
      error: 'reCAPTCHA token is required',
      code: 'RECAPTCHA_REQUIRED',
    });
  });

  it('returns false with 403 RECAPTCHA_FAILED when verification fails', async () => {
    getRecaptchaConfigMock.mockResolvedValue({ secretKeyEnc: 'enc', threshold: 0.5 });
    decryptStringMock.mockReturnValue('secret-key');
    verifyRecaptchaMock.mockResolvedValue({ success: false });
    const { reply, send, status } = makeReply();

    const result = await checkRecaptcha('token', reply);

    expect(result).toBe(false);
    expect(decryptStringMock).toHaveBeenCalledWith('enc', 'test-key');
    expect(verifyRecaptchaMock).toHaveBeenCalledWith('token', 'secret-key', 0.5);
    expect(status).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledWith({
      error: 'reCAPTCHA verification failed',
      code: 'RECAPTCHA_FAILED',
    });
  });

  it('returns true when verification succeeds', async () => {
    getRecaptchaConfigMock.mockResolvedValue({ secretKeyEnc: 'enc', threshold: 0.7 });
    decryptStringMock.mockReturnValue('secret-key');
    verifyRecaptchaMock.mockResolvedValue({ success: true, score: 0.9 });
    const { reply, status } = makeReply();

    const result = await checkRecaptcha('good-token', reply);

    expect(result).toBe(true);
    expect(verifyRecaptchaMock).toHaveBeenCalledWith('good-token', 'secret-key', 0.7);
    expect(status).not.toHaveBeenCalled();
  });

  it('throws a clear error when enabled with an empty secret key', async () => {
    getRecaptchaConfigMock.mockResolvedValue({ secretKeyEnc: '', threshold: 0.5 });
    const { reply } = makeReply();

    await expect(checkRecaptcha('token', reply)).rejects.toThrow(
      'reCAPTCHA is enabled but security.recaptcha.secretKeyEnc is not set',
    );
    expect(decryptStringMock).not.toHaveBeenCalled();
    expect(verifyRecaptchaMock).not.toHaveBeenCalled();
  });
});
