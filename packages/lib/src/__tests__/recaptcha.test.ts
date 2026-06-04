// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { verifyRecaptcha } from '../recaptcha.js';

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(json: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(json),
  } as unknown as Response;
}

describe('verifyRecaptcha', () => {
  it('returns success with score when Google verifies and the score clears the threshold', async () => {
    mockFetch.mockResolvedValue(okResponse({ success: true, score: 0.9, action: 'login' }));
    const result = await verifyRecaptcha('tok', 'secret-key', 0.5);
    expect(result).toEqual({ success: true, score: 0.9, action: 'login' });
  });

  it('returns failure when Google reports success: false even with a high score', async () => {
    mockFetch.mockResolvedValue(
      okResponse({ success: false, score: 0.95, 'error-codes': ['timeout-or-duplicate'] }),
    );
    const result = await verifyRecaptcha('tok', 'secret-key', 0.5);
    expect(result.success).toBe(false);
    expect(result.score).toBe(0.95);
    expect(result.errorCodes).toEqual(['timeout-or-duplicate']);
  });

  it('returns failure when the score is below the threshold despite success: true', async () => {
    mockFetch.mockResolvedValue(okResponse({ success: true, score: 0.3 }));
    const result = await verifyRecaptcha('tok', 'secret-key', 0.5);
    expect(result.success).toBe(false);
    expect(result.score).toBe(0.3);
  });

  it('treats a score exactly equal to the threshold as passing', async () => {
    mockFetch.mockResolvedValue(okResponse({ success: true, score: 0.5 }));
    const result = await verifyRecaptcha('tok', 'secret-key', 0.5);
    expect(result.success).toBe(true);
    expect(result.score).toBe(0.5);
  });

  it('defaults missing score to 0, which fails any positive threshold', async () => {
    mockFetch.mockResolvedValue(okResponse({ success: true }));
    const result = await verifyRecaptcha('tok', 'secret-key', 0.5);
    expect(result.success).toBe(false);
    expect(result.score).toBe(0);
  });

  it('omits action when Google does not return one', async () => {
    mockFetch.mockResolvedValue(okResponse({ success: true, score: 0.9 }));
    const result = await verifyRecaptcha('tok', 'secret-key', 0.5);
    expect(result.action).toBeUndefined();
    expect('action' in result).toBe(false);
  });

  it('omits errorCodes when Google does not return them', async () => {
    mockFetch.mockResolvedValue(okResponse({ success: true, score: 0.9 }));
    const result = await verifyRecaptcha('tok', 'secret-key', 0.5);
    expect('errorCodes' in result).toBe(false);
  });

  it('returns a safe failure with an HTTP error code when the response is not ok', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.reject(new Error('should not be called')),
    });
    const result = await verifyRecaptcha('tok', 'secret-key', 0.5);
    expect(result).toEqual({ success: false, score: 0, errorCodes: ['HTTP 503'] });
  });

  it('POSTs the secret and token as urlencoded form data to the siteverify URL', async () => {
    mockFetch.mockResolvedValue(okResponse({ success: true, score: 0.9 }));
    await verifyRecaptcha('my-token', 'my-secret', 0.5);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(VERIFY_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );

    const params = new URLSearchParams(init.body as string);
    expect(params.get('secret')).toBe('my-secret');
    expect(params.get('response')).toBe('my-token');
  });

  it('propagates a network error when fetch rejects', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    await expect(verifyRecaptcha('tok', 'secret-key', 0.5)).rejects.toThrow('network down');
  });
});
