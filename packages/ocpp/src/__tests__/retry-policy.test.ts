// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { RetryPolicy } from '../server/retry-policy.js';
import type { Logger } from '@evtivity/lib';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

describe('RetryPolicy', () => {
  it('returns result on first success', async () => {
    const policy = new RetryPolicy(mockLogger, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 });
    const result = await policy.execute('test', () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('retries on failure and succeeds', async () => {
    const policy = new RetryPolicy(mockLogger, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 });
    let attempts = 0;

    const result = await policy.execute('test', () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('throws after exhausting retries', async () => {
    const policy = new RetryPolicy(mockLogger, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100 });

    await expect(
      policy.execute('test', () => {
        throw new Error('always fails');
      }),
    ).rejects.toThrow('always fails');
  });
});
