// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { Logger } from 'pino';

// The handler invokes `client` as a tagged template twice: a station lookup,
// then a DELETE ... RETURNING that claims the watches. Return queued results in
// order and record each rendered SQL string.
const { mockClient, queries, queryValues } = vi.hoisted(() => {
  const queries: string[] = [];
  const queryValues: unknown[][] = [];
  const results: unknown[][] = [];
  let idx = 0;
  const mockClient = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(strings.join('?'));
    queryValues.push(values);
    const r = results[idx] ?? [];
    idx++;
    return Promise.resolve(r);
  }) as ReturnType<typeof vi.fn> & {
    setResults: (...r: unknown[][]) => void;
    unsafe: (text: string) => string;
  };
  mockClient.unsafe = (text: string) => text;
  mockClient.setResults = (...r: unknown[][]) => {
    results.length = 0;
    results.push(...r);
    idx = 0;
  };
  return { mockClient, queries, queryValues };
});

const dispatchDriverNotification = vi.fn(() => Promise.resolve());

// The real claim (shared driver availability rule) runs on the mocked client.
vi.mock('@evtivity/database', async () => ({
  client: mockClient,
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../../database/src/lib/station-watch.js',
  )),
}));
vi.mock('@evtivity/lib', () => ({ dispatchDriverNotification }));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish: vi.fn() }) }));

function makeLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => makeLog(),
  } as unknown as Logger;
}

// Imported once, not in the first test: loading the module graph can exceed the 5 s test timeout under load.
let stationWatchDispatchModule: typeof import('../../handlers/station-watch-dispatch.js');
beforeAll(async () => {
  stationWatchDispatchModule = await import('../../handlers/station-watch-dispatch.js');
}, 30_000);

beforeEach(() => {
  mockClient.mockClear();
  dispatchDriverNotification.mockClear();
  queries.length = 0;
  queryValues.length = 0;
});

describe('handleStationWatchDispatch', () => {
  it('claims watches and dispatches one notification per watching driver', async () => {
    mockClient.setResults(
      [{ station_id: 'CS-0001', site_name: 'Main Site' }],
      [{ driver_id: 'drv_a' }, { driver_id: 'drv_b' }],
    );
    const { handleStationWatchDispatch } = stationWatchDispatchModule;
    const log = makeLog();
    await handleStationWatchDispatch('CS-0001', log);

    // Second query is the claiming DELETE.
    expect(queries[1]).toContain('DELETE FROM station_watches');
    expect(queries[1]).toContain('RETURNING w.driver_id');
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

  // A signal can be stale (the station was disabled again, or a reservation
  // started), so the claim itself applies the shared rule: a station that is
  // not free keeps its watches and alerts nobody.
  it('claims only while the station has a free EVSE by the shared rule', async () => {
    mockClient.setResults([{ station_id: 'CS-0001', site_name: null }], []);
    const { availableEvseCountSql } = await vi.importActual<
      typeof import('../../../../database/src/lib/driver-availability.js')
    >('../../../../database/src/lib/driver-availability.js');
    const { handleStationWatchDispatch } = stationWatchDispatchModule;
    await handleStationWatchDispatch('CS-0001', makeLog());

    expect(queries[1]).toContain('DELETE FROM station_watches');
    expect(queryValues[1]).toContain(availableEvseCountSql('cs'));
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('does nothing when the station is not found', async () => {
    mockClient.setResults([]);
    const { handleStationWatchDispatch } = stationWatchDispatchModule;
    await handleStationWatchDispatch('CS-MISSING', makeLog());
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('does not dispatch when no watches are claimed', async () => {
    mockClient.setResults([{ station_id: 'CS-0001', site_name: null }], []);
    const { handleStationWatchDispatch } = stationWatchDispatchModule;
    await handleStationWatchDispatch('CS-0001', makeLog());
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });
});
