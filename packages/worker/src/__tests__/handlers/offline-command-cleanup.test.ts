// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// The handler runs a single tagged-template UPDATE ... RETURNING id and reads
// the returned array length. The mock captures the rendered SQL and returns a
// configurable array of expired rows.
const { mockClient, lastQuery } = vi.hoisted(() => {
  const lastQuery: { sql: string | null } = { sql: null };
  const mockClient = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
    lastQuery.sql = strings.join('?');
    return Promise.resolve(mockClient.rows);
  }) as ReturnType<typeof vi.fn> & { rows: unknown[] };
  mockClient.rows = [];
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
  mockClient.rows = [];
  lastQuery.sql = null;
});

describe('offlineCommandCleanupHandler', () => {
  it('expires pending commands past expires_at and logs the count', async () => {
    mockClient.rows = [{ id: 'cmd_1' }, { id: 'cmd_2' }, { id: 'cmd_3' }];
    const { offlineCommandCleanupHandler } =
      await import('../../handlers/offline-command-cleanup.js');
    const log = makeLog();
    await offlineCommandCleanupHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(lastQuery.sql).toContain('UPDATE offline_command_queue');
    expect(lastQuery.sql).toContain("status = 'expired'");
    expect(lastQuery.sql).toContain("status = 'pending'");
    expect(lastQuery.sql).toContain('expires_at <= now()');
    expect(lastQuery.sql).toContain('RETURNING id');
    expect(log.info).toHaveBeenCalledWith({ count: 3 }, 'Expired stale offline commands');
  });

  it('does not log when no commands were expired', async () => {
    mockClient.rows = [];
    const { offlineCommandCleanupHandler } =
      await import('../../handlers/offline-command-cleanup.js');
    const log = makeLog();
    await offlineCommandCleanupHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });
});
