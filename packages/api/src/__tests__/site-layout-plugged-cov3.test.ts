// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

const { client } = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock('@evtivity/database', () => ({ client }));

import {
  connectorPluggedIn,
  downConnectorKey,
  isDownConnectorStatus,
  readStatusesBeforeDown,
  statusBeforeDown,
} from '../lib/site-layout-plugged.js';

describe('site layout plugged in (cov3)', () => {
  it('names the down statuses', () => {
    expect(isDownConnectorStatus('faulted')).toBe(true);
    expect(isDownConnectorStatus('unavailable')).toBe(true);
    expect(isDownConnectorStatus('charging')).toBe(false);
  });

  it('steps over down rows to the status before the outage', () => {
    expect(
      statusBeforeDown([
        { previousStatus: 'unavailable', newStatus: 'faulted' },
        { previousStatus: null, newStatus: 'unavailable' },
        { previousStatus: 'charging', newStatus: 'faulted' },
      ]),
    ).toBe('charging');
    expect(statusBeforeDown([{ previousStatus: null, newStatus: 'faulted' }])).toBeNull();
    expect(statusBeforeDown([])).toBeNull();
    expect(statusBeforeDown([{ previousStatus: 'faulted', newStatus: 'available' }])).toBe(
      'available',
    );
  });

  it('keeps the car on a down connector only after a cable status', () => {
    const plugged = (status: string, before: string | null, hasActiveSession = false) =>
      connectorPluggedIn({ hasActiveSession, status, statusBeforeDown: before });
    expect(plugged('faulted', 'charging')).toBe(true);
    expect(plugged('faulted', 'available')).toBe(false);
    expect(plugged('faulted', null)).toBe(false);
    expect(plugged('available', null, true)).toBe(true);
    expect(plugged('available', 'charging')).toBe(false);
  });

  it('builds the connector key', () => {
    expect(downConnectorKey({ stationUuid: 'sta_1', evseId: 2, connectorId: 1 })).toBe('sta_1:2:1');
  });

  it('reads nothing for no connectors', async () => {
    expect((await readStatusesBeforeDown([])).size).toBe(0);
    expect(client).not.toHaveBeenCalled();
  });

  it('reads the history of every down connector in one query and resolves each', async () => {
    const row = (station: string, prev: string | null, next: string, id: number) => ({
      station_id: station,
      evse_id: 1,
      connector_id: 1,
      previous_status: prev,
      new_status: next,
      log_id: id,
    });
    client.mockResolvedValueOnce([
      row('sta_1', 'charging', 'faulted', 9),
      row('sta_1', null, 'charging', 8),
      row('sta_2', null, 'unavailable', 7),
    ]);
    const out = await readStatusesBeforeDown([
      { stationUuid: 'sta_1', evseId: 1, connectorId: 1 },
      { stationUuid: 'sta_2', evseId: 1, connectorId: 1 },
      { stationUuid: 'sta_3', evseId: 2, connectorId: 1 },
    ]);
    expect(client).toHaveBeenCalledTimes(1);
    // The tagged template gets the station ids, EVSE and connector numbers as arrays.
    const args = client.mock.calls[0] ?? [];
    expect(args[1]).toEqual(['sta_1', 'sta_2', 'sta_3']);
    expect(args[2]).toEqual([1, 1, 2]);
    expect(args[3]).toEqual([1, 1, 1]);
    expect(out.get('sta_1:1:1')).toBe('charging');
    expect(out.get('sta_2:1:1')).toBeNull();
    expect(out.get('sta_3:2:1')).toBeNull();
  });
});
