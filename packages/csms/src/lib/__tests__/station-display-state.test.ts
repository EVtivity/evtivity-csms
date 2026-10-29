// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  STATION_DISPLAY_STATES,
  connectorIconName,
  stationDisplayState,
  stationStateColor,
  stationStateLabelKey,
} from '../station-display-state';
import { STATUS_COLORS } from '../chart-theme';

const station = (
  overrides: Partial<Parameters<typeof stationDisplayState>[0]> = {},
  connectorStatuses: string[] = ['available'],
): Parameters<typeof stationDisplayState>[0] => ({
  status: 'available',
  isOnline: true,
  inMaintenance: false,
  evses: [{ connectors: connectorStatuses.map((status) => ({ status })) }],
  ...overrides,
});

describe('stationDisplayState', () => {
  it('lists the states most severe first', () => {
    expect(STATION_DISPLAY_STATES).toEqual([
      'faulted',
      'unavailable',
      'maintenance',
      'offline',
      'reserved',
      'charging',
      'available',
      'online',
    ]);
  });

  it('shows faulted over every other state, also for a faulted connector while charging', () => {
    expect(
      stationDisplayState(
        station({ status: 'faulted', isOnline: false, inMaintenance: true }, ['reserved']),
      ),
    ).toBe('faulted');
    expect(stationDisplayState(station({ status: 'charging' }, ['charging', 'faulted']))).toBe(
      'faulted',
    );
  });

  it('shows unavailable over maintenance and offline', () => {
    expect(
      stationDisplayState(station({ status: 'unavailable', isOnline: false, inMaintenance: true })),
    ).toBe('unavailable');
  });

  it('shows maintenance over offline, offline over reserved', () => {
    expect(stationDisplayState(station({ inMaintenance: true, isOnline: false }))).toBe(
      'maintenance',
    );
    expect(stationDisplayState(station({ status: 'reserved', isOnline: false }))).toBe('offline');
  });

  it('shows reserved over charging, then charging, available and online', () => {
    expect(stationDisplayState(station({ status: 'charging' }, ['charging', 'reserved']))).toBe(
      'reserved',
    );
    expect(stationDisplayState(station({ status: 'charging' }, ['charging']))).toBe('charging');
    expect(stationDisplayState(station())).toBe('available');
    expect(stationDisplayState(station({ status: 'unknown' }, []))).toBe('online');
  });

  it('labels and colors every state from the shared tokens', () => {
    for (const state of STATION_DISPLAY_STATES) {
      expect(stationStateLabelKey(state)).toBe(`sites.layoutState.${state}`);
      expect(stationStateColor(state)).not.toBe('');
    }
    expect(stationStateColor('faulted')).toBe(STATUS_COLORS['faulted']);
    expect(stationStateColor('reserved')).toBe(STATUS_COLORS['reserved']);
    expect(stationStateColor('charging')).toBe(STATUS_COLORS['charging']);
    expect(stationStateColor('maintenance')).toBe('hsl(var(--warning))');
    expect(stationStateColor('offline')).toBe('hsl(var(--muted-foreground))');
  });
});

describe('connectorIconName', () => {
  it('follows the connector status icon mapping', () => {
    expect(connectorIconName('available')).toBe('check');
    expect(connectorIconName('charging')).toBe('zap');
    expect(connectorIconName('occupied')).toBe('zap');
    expect(connectorIconName('preparing')).toBe('plug');
    expect(connectorIconName('ev_connected')).toBe('plug');
    expect(connectorIconName('reserved')).toBe('clock');
    expect(connectorIconName('suspended_ev')).toBe('pause');
    expect(connectorIconName('suspended_evse')).toBe('pause');
    expect(connectorIconName('idle')).toBe('pause');
    expect(connectorIconName('faulted')).toBe('alert');
    expect(connectorIconName('unavailable')).toBe('x');
    expect(connectorIconName('finishing')).toBe('none');
  });
});
