// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

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
});
