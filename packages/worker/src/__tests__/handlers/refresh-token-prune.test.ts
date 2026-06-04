// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// The handler calls `client` twice: first the settings SELECT, then the DELETE
// (when retention is enabled). The mock records each call's rendered SQL and
// interpolated values, and returns queued results in call order.
interface CapturedCall {
  sql: string;
  values: unknown[];
}

const { mockClient, calls, results } = vi.hoisted(() => {
  const calls: CapturedCall[] = [];
  const results: unknown[] = [];
  let idx = 0;
  const mockClient = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join('?'), values });
    const r = results[idx] ?? [];
    idx++;
    return Promise.resolve(r);
  });
  // Expose a reset that also clears the internal index.
  (mockClient as unknown as { __reset: () => void }).__reset = () => {
    calls.length = 0;
    results.length = 0;
    idx = 0;
  };
  return { mockClient, calls, results };
});

vi.mock('@evtivity/database', () => ({
  client: mockClient,
}));

function makeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function queueResults(...r: unknown[]): void {
  results.push(...r);
}

beforeEach(() => {
  mockClient.mockClear();
  (mockClient as unknown as { __reset: () => void }).__reset();
});

describe('refreshTokenPruneHandler', () => {
  it('uses the configured numeric retention and deletes revoked/expired rows', async () => {
    queueResults([{ value: 60 }], { count: 4 });
    const { refreshTokenPruneHandler } = await import('../../handlers/refresh-token-prune.js');
    const log = makeLog();
    await refreshTokenPruneHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(2);
    // First query reads the setting.
    expect(calls[0]!.sql).toContain("settings WHERE key = 'refreshTokens.retentionDays'");
    // Second query deletes and interpolates the retentionDays (60).
    expect(calls[1]!.sql).toContain('DELETE FROM refresh_tokens');
    expect(calls[1]!.sql).toContain('revoked_at IS NOT NULL');
    expect(calls[1]!.sql).toContain('expires_at IS NOT NULL');
    expect(calls[1]!.values).toContain(60);
    expect(log.info).toHaveBeenCalledWith(
      { deleted: 4, retentionDays: 60 },
      'refresh-token-prune: completed',
    );
  });

  it('defaults to 30 days when the setting row is missing', async () => {
    queueResults([], { count: 1 });
    const { refreshTokenPruneHandler } = await import('../../handlers/refresh-token-prune.js');
    await refreshTokenPruneHandler(makeLog());

    expect(mockClient).toHaveBeenCalledTimes(2);
    expect(calls[1]!.values).toContain(30);
  });

  it('parses a numeric string setting value via parseInt', async () => {
    queueResults([{ value: '14' }], { count: 0 });
    const { refreshTokenPruneHandler } = await import('../../handlers/refresh-token-prune.js');
    await refreshTokenPruneHandler(makeLog());

    expect(calls[1]!.values).toContain(14);
  });

  it('skips the DELETE and logs disabled when retention is zero', async () => {
    queueResults([{ value: 0 }]);
    const { refreshTokenPruneHandler } = await import('../../handlers/refresh-token-prune.js');
    const log = makeLog();
    await refreshTokenPruneHandler(log);

    // Only the settings SELECT ran; no DELETE.
    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ retentionDays: 0 }, 'refresh-token-prune: disabled');
  });

  it('skips the DELETE when a string setting parses to a non-positive number', async () => {
    queueResults([{ value: '-5' }]);
    const { refreshTokenPruneHandler } = await import('../../handlers/refresh-token-prune.js');
    const log = makeLog();
    await refreshTokenPruneHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ retentionDays: -5 }, 'refresh-token-prune: disabled');
  });

  it('skips the DELETE when a string setting parses to NaN (non-finite)', async () => {
    queueResults([{ value: 'not-a-number' }]);
    const { refreshTokenPruneHandler } = await import('../../handlers/refresh-token-prune.js');
    const log = makeLog();
    await refreshTokenPruneHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.info).mock.calls[0]![1]).toBe('refresh-token-prune: disabled');
  });
});
