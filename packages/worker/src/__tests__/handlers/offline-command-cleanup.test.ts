// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import * as offlineCommandCleanupModule from '../../handlers/offline-command-cleanup.js';

// The handler runs a single tagged-template UPDATE ... RETURNING id and reads
// the returned array length. The mock captures the rendered SQL and returns a
// configurable array of expired rows.
const { mockClient, lastQuery, mockReject } = vi.hoisted(() => {
  const lastQuery: { sql: string | null } = { sql: null };
  const mockClient = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
    lastQuery.sql = strings.join('?');
    return Promise.resolve(mockClient.rows);
  }) as ReturnType<typeof vi.fn> & { rows: unknown[] };
  mockClient.rows = [];
  const mockReject = vi.fn().mockResolvedValue(null);
  return { mockClient, lastQuery, mockReject };
});

vi.mock('@evtivity/database', () => ({
  client: mockClient,
  rejectFirmwareUpdate: mockReject,
}));

function makeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

beforeEach(() => {
  mockClient.mockClear();
  mockReject.mockClear();
  mockReject.mockResolvedValue(null);
  mockClient.rows = [];
  lastQuery.sql = null;
});

describe('offlineCommandCleanupHandler', () => {
  it('expires pending commands past expires_at and logs the count', async () => {
    mockClient.rows = [{ id: 'cmd_1' }, { id: 'cmd_2' }, { id: 'cmd_3' }];
    const { offlineCommandCleanupHandler } = offlineCommandCleanupModule;
    const log = makeLog();
    await offlineCommandCleanupHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(lastQuery.sql).toContain('UPDATE offline_command_queue');
    expect(lastQuery.sql).toContain("status = 'expired'");
    expect(lastQuery.sql).toContain("status = 'pending'");
    expect(lastQuery.sql).toContain('expires_at <= now()');
    expect(lastQuery.sql).toContain('RETURNING q.id');
    expect(log.info).toHaveBeenCalledWith({ count: 3 }, 'Expired stale offline commands');
  });

  it('ends an expired queued firmware update so its campaign can complete', async () => {
    mockClient.rows = [
      {
        id: 1,
        action: 'UpdateFirmware',
        payload: { requestId: 77, firmware: { location: 'https://fw' } },
        station_uuid: 'sta_1',
      },
      { id: 2, action: 'Reset', payload: { type: 'Soft' }, station_uuid: 'sta_1' },
      { id: 3, action: 'SignedUpdateFirmware', payload: { requestId: 78 }, station_uuid: null },
    ];
    const log = makeLog();
    await offlineCommandCleanupModule.offlineCommandCleanupHandler(log);

    expect(mockReject).toHaveBeenCalledTimes(1);
    expect(mockReject).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({ stationUuid: 'sta_1', requestId: 77, reasonCode: 'QueueExpired' }),
    );
  });

  it('keeps expiring the other rows when ending one firmware update fails', async () => {
    mockClient.rows = [
      { id: 1, action: 'UpdateFirmware', payload: { requestId: 1 }, station_uuid: 'sta_1' },
      { id: 2, action: 'UpdateFirmware', payload: { requestId: 2 }, station_uuid: 'sta_2' },
    ];
    mockReject.mockRejectedValueOnce(new Error('db down'));
    const log = makeLog();
    await offlineCommandCleanupModule.offlineCommandCleanupHandler(log);

    expect(mockReject).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('does not log when no commands were expired', async () => {
    mockClient.rows = [];
    const { offlineCommandCleanupHandler } = offlineCommandCleanupModule;
    const log = makeLog();
    await offlineCommandCleanupHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });
});
