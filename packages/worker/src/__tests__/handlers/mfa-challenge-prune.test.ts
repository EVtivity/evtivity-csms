// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// The handler invokes `client` as a tagged template: client`DELETE ...`.
// The mock captures the rendered SQL string and returns a configurable result.
const { mockClient, lastQuery } = vi.hoisted(() => {
  const lastQuery: { sql: string | null } = { sql: null };
  const mockClient = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
    lastQuery.sql = strings.join('?');
    return Promise.resolve(mockClient.result);
  }) as ReturnType<typeof vi.fn> & { result: unknown };
  mockClient.result = { count: 0 };
  return { mockClient, lastQuery };
});

vi.mock('@evtivity/database', () => ({
  client: mockClient,
}));

function makeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

beforeEach(() => {
  mockClient.mockClear();
  mockClient.result = { count: 0 };
  lastQuery.sql = null;
});

describe('mfaChallengePruneHandler', () => {
  it('deletes expired or consumed challenges and logs the count', async () => {
    mockClient.result = { count: 7 };
    const { mfaChallengePruneHandler } = await import('../../handlers/mfa-challenge-prune.js');
    const log = makeLog();
    await mfaChallengePruneHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(lastQuery.sql).toContain('DELETE FROM mfa_challenges');
    expect(lastQuery.sql).toContain('expires_at < NOW()');
    expect(lastQuery.sql).toContain('used_at IS NOT NULL');
    expect(log.info).toHaveBeenCalledWith({ deleted: 7 }, 'mfa-challenge-prune: completed');
  });

  it('logs zero when there is nothing to prune', async () => {
    mockClient.result = { count: 0 };
    const { mfaChallengePruneHandler } = await import('../../handlers/mfa-challenge-prune.js');
    const log = makeLog();
    await mfaChallengePruneHandler(log);

    expect(log.info).toHaveBeenCalledWith({ deleted: 0 }, 'mfa-challenge-prune: completed');
  });
});
