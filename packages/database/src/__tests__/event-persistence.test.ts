// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

const values = vi.fn((_row: unknown) => Promise.resolve());

vi.mock('../config.js', () => ({
  db: { insert: vi.fn(() => ({ values })) },
}));

import { PgEventPersistence } from '../event-persistence.js';

describe('PgEventPersistence', () => {
  it('stores a file transfer URL with its password masked and leaves the event unchanged', async () => {
    const url = 'ftp://fw:UrlSecret99@files.example.com/fw.bin';
    const event = {
      eventType: 'command.Queued',
      aggregateType: 'ChargingStation',
      aggregateId: 'CS-1',
      payload: {
        commandId: 'c1',
        action: 'UpdateFirmware',
        payload: { requestId: 1, firmware: { location: url, retrieveDateTime: 'x' } },
      },
    };
    await new PgEventPersistence().persist(event);
    const row = values.mock.calls[0]?.[0] as { payload: unknown };
    expect(JSON.stringify(row.payload)).toContain('ftp://fw:[redacted]@files.example.com/fw.bin');
    expect(JSON.stringify(row.payload)).not.toContain('UrlSecret99');
    // The projection gets the real command (the offline queue delivers it).
    expect(JSON.stringify(event.payload)).toContain(url);
  });
});
