// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  STARTABLE_CONNECTOR_STATUSES,
  availableEvseCountSql,
  evseAvailableSql,
  evseOpenToDriversSql,
  stationOpenToDriversSql,
} from '../lib/driver-availability.js';
import { isStationLevelUnavailable, stationLevelUnavailableSql } from '../lib/station-status.js';

describe('stationLevelUnavailableSql', () => {
  it('checks the same inputs as isStationLevelUnavailable', () => {
    const text = stationLevelUnavailableSql('cs');
    expect(text).toContain('cs.disabled_reason IS NOT NULL');
    expect(text).toContain('cs.firmware_state IS NOT NULL');
    expect(text).toContain("cs.reported_status = 'unavailable'");
    expect(text).toContain("cs.reported_status = 'faulted'");
    // The JS rule it mirrors.
    expect(
      isStationLevelUnavailable({
        disabledReason: 'operator',
        firmwareState: null,
        reportedStatus: null,
      }),
    ).toBe(true);
  });
});

describe('driver availability SQL', () => {
  it('opens a station to drivers only when online, not station-level unavailable, and not under maintenance', () => {
    const text = stationOpenToDriversSql('cs');
    expect(text).toContain('cs.is_online');
    expect(text).toContain(`NOT ${stationLevelUnavailableSql('cs')}`);
    expect(text).toContain('maintenance_events');
    expect(text).toContain("status = 'active'");
    expect(text).toContain('planned_start_at <= now()');
    expect(text).toContain('planned_end_at > now()');
  });

  it('closes an EVSE that holds a current reservation, including a station-wide one', () => {
    const text = evseOpenToDriversSql('e', 'cs');
    expect(text).toContain(stationOpenToDriversSql('cs'));
    expect(text).toContain('FROM reservations');
    expect(text).toContain('.evse_id = e.id');
    expect(text).toContain('.evse_id IS NULL');
    expect(text).toContain("IN ('active', 'scheduled')");
    expect(text).toContain('expires_at > now()');
  });

  it('counts an EVSE as available only when it is open and has an available connector', () => {
    const text = evseAvailableSql('e', 'cs');
    expect(text).toContain(evseOpenToDriversSql('e', 'cs'));
    expect(text).toContain(".status = 'available'");
  });

  it('counts the available EVSEs of a station', () => {
    const text = availableEvseCountSql('charging_stations');
    expect(text).toMatch(/^\(SELECT count\(\*\)::int FROM evses /);
    expect(text).toContain('.station_id = charging_stations.id');
    expect(text).toContain('charging_stations.is_online');
  });

  it('lists the statuses a driver can start on', () => {
    expect(STARTABLE_CONNECTOR_STATUSES).toEqual([
      'available',
      'occupied',
      'preparing',
      'ev_connected',
      'finishing',
    ]);
  });
});
