// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  STATION_DISPLAY_STATES,
  connectorIconName,
  connectorStatusColor,
  evseDisplayState,
  resolveCssColor,
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
      'maintenance',
      'unavailable',
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

  it('shows maintenance over the unavailable and offline state its window causes', () => {
    // A maintenance window sets its stations Inoperative: they report Unavailable.
    expect(
      stationDisplayState(station({ status: 'unavailable', isOnline: false, inMaintenance: true })),
    ).toBe('maintenance');
    expect(
      stationDisplayState(station({ status: 'unavailable', inMaintenance: true }, ['unavailable'])),
    ).toBe('maintenance');
    expect(stationDisplayState(station({ status: 'unavailable' }))).toBe('unavailable');
  });

  it('shows a fault over maintenance', () => {
    expect(
      stationDisplayState(station({ status: 'unavailable', inMaintenance: true }, ['faulted'])),
    ).toBe('faulted');
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

describe('evseDisplayState', () => {
  const evse = (...statuses: string[]) => ({ connectors: statuses.map((status) => ({ status })) });

  it('shows a fault first, then all unavailable, reserved, in use and available', () => {
    expect(evseDisplayState(evse('Available', 'Faulted'))).toBe('faulted');
    expect(evseDisplayState(evse('Unavailable', 'Unavailable'))).toBe('unavailable');
    expect(evseDisplayState(evse('Unavailable', 'Available'))).toBe('available');
    expect(evseDisplayState(evse('Reserved', 'Charging'))).toBe('reserved');
    expect(evseDisplayState(evse('Charging'))).toBe('charging');
    expect(evseDisplayState(evse('Available'))).toBe('available');
  });

  it('counts a plugged-in cable as in use, and shows online without a known status', () => {
    expect(evseDisplayState({ connectors: [{ status: 'Available', isPluggedIn: true }] })).toBe(
      'charging',
    );
    expect(evseDisplayState(evse())).toBe('online');
    expect(evseDisplayState(evse('Unknown'))).toBe('online');
  });
});

describe('colors', () => {
  it('draws an online station in the success token and an offline one muted', () => {
    expect(stationStateColor('online')).toBe('hsl(var(--success))');
    expect(stationStateColor('offline')).toBe('hsl(var(--muted-foreground))');
  });

  it('mutes an unknown connector status', () => {
    expect(connectorStatusColor('charging')).toBe(STATUS_COLORS['charging']);
    expect(connectorStatusColor('something_new')).toBe('hsl(var(--muted-foreground))');
  });

  it('resolves a theme token to a parseable color, a gray when unset, and other colors as is', () => {
    document.documentElement.style.setProperty('--warning', '37.7 92.1% 50.2%');
    expect(resolveCssColor('hsl(var(--warning))')).toBe('hsl(37.7, 92.1%, 50.2%)');
    document.documentElement.style.removeProperty('--warning');
    expect(resolveCssColor('hsl(var(--warning))')).toBe('#6b7280');
    expect(resolveCssColor('#22c55e')).toBe('#22c55e');
  });
});
