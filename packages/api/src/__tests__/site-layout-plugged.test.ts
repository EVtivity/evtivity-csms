// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ client: vi.fn() }));

import {
  PLUGGED_CONNECTOR_STATUSES,
  connectorPluggedIn,
  statusBeforeDown,
} from '../lib/site-layout-plugged.js';

describe('site layout plugged in', () => {
  it('shows the car for exactly the statuses of the car and flow table (site layout standards)', () => {
    // OCPP 1.6: Preparing, Charging, SuspendedEV, SuspendedEVSE, Finishing; 2.x: Occupied and the
    // chargingState values Charging, Discharging, EVConnected, Idle, SuspendedEV, SuspendedEVSE.
    expect([...PLUGGED_CONNECTOR_STATUSES].sort()).toEqual(
      [
        'charging',
        'discharging',
        'ev_connected',
        'finishing',
        'idle',
        'occupied',
        'preparing',
        'suspended_ev',
        'suspended_evse',
      ].sort(),
    );
    for (const status of ['available', 'reserved']) {
      expect(PLUGGED_CONNECTOR_STATUSES.has(status), status).toBe(false);
    }
  });

  it('keeps the car of an injected fault that ended the session (2.1: charging, then Ended, then Faulted)', () => {
    const before = statusBeforeDown([
      { previousStatus: 'ev_connected', newStatus: 'faulted' },
      { previousStatus: 'charging', newStatus: 'ev_connected' },
    ]);
    expect(before).toBe('ev_connected');
    expect(
      connectorPluggedIn({ hasActiveSession: false, status: 'faulted', statusBeforeDown: before }),
    ).toBe(true);
  });

  it('keeps it for an OCPP 1.6 fault after Finishing', () => {
    const before = statusBeforeDown([{ previousStatus: 'finishing', newStatus: 'faulted' }]);
    expect(
      connectorPluggedIn({ hasActiveSession: false, status: 'faulted', statusBeforeDown: before }),
    ).toBe(true);
  });

  it('steps over the outage rows a disconnect and reconnect write during the fault', () => {
    const before = statusBeforeDown([
      { previousStatus: 'unavailable', newStatus: 'faulted' },
      { previousStatus: 'faulted', newStatus: 'unavailable' },
      { previousStatus: 'charging', newStatus: 'faulted' },
    ]);
    expect(before).toBe('charging');
  });

  it('shows no car for a fault of an empty connector, or after the car left', () => {
    expect(
      connectorPluggedIn({
        hasActiveSession: false,
        status: 'faulted',
        statusBeforeDown: statusBeforeDown([{ previousStatus: 'available', newStatus: 'faulted' }]),
      }),
    ).toBe(false);
    // Unplugged and cleared, then a later fault: the newest status before it is Available.
    expect(
      statusBeforeDown([
        { previousStatus: 'available', newStatus: 'faulted' },
        { previousStatus: 'faulted', newStatus: 'available' },
        { previousStatus: 'charging', newStatus: 'faulted' },
      ]),
    ).toBe('available');
    expect(
      connectorPluggedIn({ hasActiveSession: false, status: 'faulted', statusBeforeDown: null }),
    ).toBe(false);
  });

  it('counts a session and every status that reports a cable, and nothing else', () => {
    expect(
      connectorPluggedIn({ hasActiveSession: true, status: 'available', statusBeforeDown: null }),
    ).toBe(true);
    for (const status of ['occupied', 'preparing', 'finishing', 'suspended_ev', 'charging']) {
      expect(
        connectorPluggedIn({ hasActiveSession: false, status, statusBeforeDown: null }),
        status,
      ).toBe(true);
    }
    for (const status of ['available', 'reserved']) {
      expect(
        connectorPluggedIn({ hasActiveSession: false, status, statusBeforeDown: 'charging' }),
        status,
      ).toBe(false);
    }
  });
});
