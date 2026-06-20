// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const { mockClient, lastQuery } = vi.hoisted(() => {
  const lastQuery: { sql: string | null } = { sql: null };
  const mockClient = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
    lastQuery.sql = strings.join('?');
    return Promise.resolve(mockClient.result);
  }) as ReturnType<typeof vi.fn> & { result: unknown };
  mockClient.result = { count: 0 };
  return { mockClient, lastQuery };
});

vi.mock('@evtivity/database', () => ({ client: mockClient }));

function makeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

beforeEach(() => {
  mockClient.mockClear();
  mockClient.result = { count: 0 };
  lastQuery.sql = null;
});

describe('stationWatchPruneHandler', () => {
  it('deletes expired watches and logs the count', async () => {
    mockClient.result = { count: 4 };
    const { stationWatchPruneHandler } = await import('../../handlers/station-watch-prune.js');
    const log = makeLog();
    await stationWatchPruneHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(lastQuery.sql).toContain('DELETE FROM station_watches');
    expect(lastQuery.sql).toContain('expires_at < NOW()');
    expect(log.info).toHaveBeenCalledWith({ deleted: 4 }, 'station-watch-prune: completed');
  });
});
