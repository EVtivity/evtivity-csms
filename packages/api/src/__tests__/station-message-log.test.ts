// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();

const execute = vi.fn();

vi.mock('@evtivity/database', () => ({
  db: { execute: (...args: unknown[]) => execute(...args) as unknown },
  toDate: (v: unknown) => new Date(v as string),
}));

import { listStationMessageLog } from '../lib/station-message-log.js';

describe('listStationMessageLog', () => {
  it('shows a queued command with its file transfer URL password masked', async () => {
    const url = 'ftp://fw:UrlSecret99@files.example.com/fw.bin';
    execute
      .mockResolvedValueOnce([
        {
          id: 1,
          station_id: 'sta_1',
          direction: 'outbound',
          message_type: 2,
          message_id: 'cmd-1',
          action: 'UpdateFirmware',
          payload: { requestId: 1, firmware: { location: url, retrieveDateTime: 'x' } },
          error_code: null,
          error_description: null,
          created_at: '2026-10-27T00:00:00Z',
          processing_status: 'queued',
        },
      ])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ action: 'UpdateFirmware' }]);

    const page = await listStationMessageLog('sta_1', { page: 1, limit: 20 });

    expect(page.total).toBe(1);
    expect(JSON.stringify(page.data[0]?.payload)).toContain(
      'ftp://fw:[redacted]@files.example.com/fw.bin',
    );
    expect(JSON.stringify(page)).not.toContain('UrlSecret99');
  });

  it('leaves security event rows out of the rows, the total and the action list when hidden', async () => {
    execute.mockReset();
    execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ action: 'Heartbeat' }, { action: 'SecurityEventNotification' }])
      .mockResolvedValueOnce([]);

    const page = await listStationMessageLog('sta_1', {
      page: 1,
      limit: 20,
      hiddenActions: ['SecurityEventNotification'],
    });

    expect(page.actions).toEqual(['Heartbeat']);
    // The rows, the log count and the queued count all carry the filter.
    for (const call of execute.mock.calls.slice(0, 3)) {
      const query = dialect.sqlToQuery(call[0] as SQL);
      expect(query.sql).toMatch(/IS NULL OR \S+ NOT IN \(\$\d+\)/);
      expect(query.params).toContain('SecurityEventNotification');
    }
  });

  it('adds no action filter for a reader with securityEvents:read', async () => {
    execute.mockReset();
    execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ action: 'SecurityEventNotification' }])
      .mockResolvedValueOnce([]);

    const page = await listStationMessageLog('sta_1', { page: 1, limit: 20, hiddenActions: [] });

    expect(page.actions).toEqual(['SecurityEventNotification']);
    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0] as SQL);
    expect(query.sql).not.toContain('NOT IN');
  });
});
