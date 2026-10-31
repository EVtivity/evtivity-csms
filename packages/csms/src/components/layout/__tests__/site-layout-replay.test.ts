// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  normalizeConnectorStatus,
  powerAt,
  replayFrame,
  replayLastMinute,
  replayMoment,
  sessionAt,
  type ReplayDay,
} from '../site-layout-replay';
import type { LayoutStation } from '../StationCard';
import { stationDisplayState } from '@/lib/station-display-state';

const FROM = '2026-10-30T04:00:00.000Z';
const TO = '2026-10-31T03:59:59.999Z';
const at = (h: number, m = 0): number => Date.parse(FROM) + (h * 60 + m) * 60_000;
const iso = (h: number, m = 0): string => new Date(at(h, m)).toISOString();

const station = (id: string): LayoutStation => ({
  id,
  stationId: id.toUpperCase(),
  model: 'DC150',
  status: 'available',
  isOnline: true,
  securityProfile: 1,
  positionX: 0,
  positionY: 0,
  placed: true,
  chargingKind: 'dc',
  cellular: false,
  inMaintenance: true,
  displayMessage: 'Live message',
  evses: [
    {
      evseId: 1,
      status: 'available',
      connectors: [
        {
          connectorId: 1,
          connectorType: 'CCS2',
          maxPowerKw: 150,
          status: 'available',
          isPluggedIn: false,
          energyDeliveredWh: null,
        },
      ],
    },
  ],
  session: {
    id: 'ses_live',
    startedAt: iso(20),
    energyDeliveredWh: 1000,
    currentCostCents: 100,
    currency: 'USD',
    driver: null,
  },
});

const day: ReplayDay = {
  date: '2026-10-30',
  timezone: 'America/New_York',
  from: FROM,
  to: TO,
  stations: [
    {
      id: 'a',
      initialOnline: true,
      onlineChanges: [
        { at: iso(15), online: false },
        { at: iso(16), online: true },
      ],
      connectors: [
        {
          evseId: 1,
          connectorId: 1,
          initialStatus: 'Available',
          changes: [
            { at: iso(9), status: 'Occupied' },
            { at: iso(10), status: 'Available' },
            { at: iso(12), status: 'Faulted' },
            { at: iso(13), status: 'Available' },
          ],
        },
      ],
      sessions: [{ startedAt: iso(9), endedAt: iso(10), energyWh: 30_000 }],
      power: [
        { at: iso(9), kw: 120 },
        { at: iso(9, 30), kw: 90 },
      ],
    },
  ],
};

describe('day replay', () => {
  it('maps OCPP connector statuses to the layout spelling', () => {
    expect(normalizeConnectorStatus('Charging')).toBe('occupied');
    expect(normalizeConnectorStatus('SuspendedEV')).toBe('occupied');
    expect(normalizeConnectorStatus('Faulted')).toBe('faulted');
    expect(normalizeConnectorStatus(null)).toBe('unknown');
  });

  it('shows a session charging with its energy so far, spread over the session', () => {
    const frame = replayFrame(day, [station('a')], at(9, 30), at(23));
    const s = frame.stations[0];
    expect(s?.status).toBe('charging');
    expect(s?.evses[0]?.connectors[0]?.energyDeliveredWh).toBe(15_000);
    expect(s != null && stationDisplayState(s)).toBe('charging');
    expect(frame.power.get('a')?.currentDrawKw).toBe(90);
  });

  it('shows a fault, the station going offline and back, and idle power as 0', () => {
    expect(replayFrame(day, [station('a')], at(12, 30), at(23)).stations[0]?.status).toBe(
      'faulted',
    );
    const offline = replayFrame(day, [station('a')], at(15, 30), at(23));
    expect(offline.stations[0]?.isOnline).toBe(false);
    expect(offline.power.get('a')?.currentDrawKw).toBe(0);
    const back = replayFrame(day, [station('a')], at(16, 30), at(23));
    expect(back.stations[0] != null && stationDisplayState(back.stations[0])).toBe('available');
    expect(back.power.get('a')?.currentDrawKw).toBe(0);
  });

  it('leaves out live-only data and shows a station the replay does not cover as offline', () => {
    const frame = replayFrame(day, [station('a'), station('b')], at(8), at(23));
    expect(frame.stations[0]?.session).toBeNull();
    expect(frame.stations[0]?.displayMessage).toBeNull();
    expect(frame.stations[0]?.inMaintenance).toBe(false);
    expect(frame.stations[1]?.isOnline).toBe(false);
  });

  it('runs an open session until now on today, until the end of a past day', () => {
    const open = [{ startedAt: iso(9), endedAt: null, energyWh: 10_000 }];
    expect(sessionAt(open, at(11), at(13))).not.toBeNull();
    expect(sessionAt(open, at(14), at(13))).toBeNull();
  });

  it('counts a power sample only within its 5-minute bucket', () => {
    const power = [{ at: iso(9), kw: 50 }];
    expect(powerAt(power, at(9, 4))).toBe(50);
    expect(powerAt(power, at(9, 6))).toBe(0);
    expect(powerAt(power, at(8, 59))).toBe(0);
  });

  it('turns slider minutes into moments of the day and stops at now on today', () => {
    expect(replayMoment(day, 90)).toBe(at(1, 30));
    expect(replayMoment(day, 5000)).toBe(Date.parse(TO));
    expect(replayLastMinute(day, at(6, 15))).toBe(375);
    expect(replayLastMinute(day, at(48))).toBe(1439);
  });
});
