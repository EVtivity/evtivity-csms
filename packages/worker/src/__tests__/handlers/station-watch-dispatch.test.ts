// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// The handler invokes `client` as a tagged template twice: a station lookup,
// then a DELETE ... RETURNING that claims the watches. Return queued results in
// order and record each rendered SQL string.
const { mockClient, queries } = vi.hoisted(() => {
  const queries: string[] = [];
  const results: unknown[][] = [];
  let idx = 0;
  const mockClient = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
    queries.push(strings.join('?'));
    const r = results[idx] ?? [];
    idx++;
    return Promise.resolve(r);
  }) as ReturnType<typeof vi.fn> & { setResults: (...r: unknown[][]) => void };
  mockClient.setResults = (...r: unknown[][]) => {
    results.length = 0;
    results.push(...r);
    idx = 0;
  };
  return { mockClient, queries };
});

const dispatchDriverNotification = vi.fn(() => Promise.resolve());

vi.mock('@evtivity/database', () => ({ client: mockClient }));
vi.mock('@evtivity/lib', () => ({ dispatchDriverNotification }));
vi.mock('@evtivity/api/src/lib/pubsub.js', () => ({ getPubSub: () => ({ publish: vi.fn() }) }));

function makeLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => makeLog(),
  } as unknown as Logger;
}

beforeEach(() => {
  mockClient.mockClear();
  dispatchDriverNotification.mockClear();
  queries.length = 0;
});

describe('handleStationWatchDispatch', () => {
  it('claims watches and dispatches one notification per watching driver', async () => {
    mockClient.setResults(
      [{ station_id: 'CS-0001', site_name: 'Main Site' }],
      [{ driver_id: 'drv_a' }, { driver_id: 'drv_b' }],
    );
    const { handleStationWatchDispatch } = await import('../../handlers/station-watch-dispatch.js');
    const log = makeLog();
    await handleStationWatchDispatch('CS-0001', log);

    // Second query is the claiming DELETE.
    expect(queries[1]).toContain('DELETE FROM station_watches');
    expect(queries[1]).toContain('RETURNING driver_id');
    expect(dispatchDriverNotification).toHaveBeenCalledTimes(2);
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      mockClient,
      'watch.StationAvailable',
      'drv_a',
      expect.objectContaining({
        stationId: 'CS-0001',
        stationName: 'CS-0001',
        siteName: 'Main Site',
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('does nothing when the station is not found', async () => {
    mockClient.setResults([]);
    const { handleStationWatchDispatch } = await import('../../handlers/station-watch-dispatch.js');
    await handleStationWatchDispatch('CS-MISSING', makeLog());
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('does not dispatch when no watches are claimed', async () => {
    mockClient.setResults([{ station_id: 'CS-0001', site_name: null }], []);
    const { handleStationWatchDispatch } = await import('../../handlers/station-watch-dispatch.js');
    await handleStationWatchDispatch('CS-0001', makeLog());
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });
});
