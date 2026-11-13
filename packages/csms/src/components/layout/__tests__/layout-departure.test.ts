// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { formatDepotTime } from '@/lib/depot-time';
import { stationStateTextColor } from '@/lib/station-display-state';
import { departureLabel, departureTextColor } from '../layout-departure';
import type { LayoutSessionDeparture } from '../StationCard';

const t = ((key: string, opts?: Record<string, unknown>) =>
  opts == null ? key : `${key}:${JSON.stringify(opts)}`) as unknown as TFunction;

function departure(over: Partial<LayoutSessionDeparture> = {}): LayoutSessionDeparture {
  return {
    id: 'dep_1',
    departureAt: '2026-06-10T05:30:00Z',
    timezone: 'UTC',
    readiness: null,
    reason: null,
    targetKwh: 200,
    targetSocPercent: null,
    deliveredKwh: 120,
    shortfallKwh: null,
    predictedReadyAt: null,
    ...over,
  };
}

describe('departureLabel', () => {
  it('shows the departure time and no readiness while the plan does not run', () => {
    const l = departureLabel(departure(), t);
    expect(l.departs).toMatch(/^sites\.layoutView\.departs:/);
    expect(l.departs).toContain(formatDepotTime('2026-06-10T05:30:00Z', 'UTC'));
    expect(l.state).toBeNull();
    expect(l.color).toBeNull();
  });

  it('says as soon as possible for an ad hoc request', () => {
    expect(departureLabel(departure({ departureAt: null }), t).departs).toBe(
      'fleets.departures.asSoonAsPossible',
    );
  });

  it('shows when a ready or on-track vehicle is ready, else that it is ready', () => {
    const at = departureLabel(
      departure({ readiness: 'on_track', predictedReadyAt: '2026-06-10T04:10:00Z' }),
      t,
    );
    expect(at.state).toContain('sites.layoutView.readyAt');
    expect(at.state).toContain(formatDepotTime('2026-06-10T04:10:00Z', 'UTC'));
    expect(at.color).toBe(stationStateTextColor('charging'));
    expect(departureLabel(departure({ readiness: 'ready' }), t).state).toBe(
      'fleets.departures.readiness.ready',
    );
  });

  it('names the shortfall of an at-risk or failing departure when there is one', () => {
    expect(departureLabel(departure({ readiness: 'at_risk', shortfallKwh: 32.4 }), t).state).toBe(
      'sites.layoutView.atRiskShort:{"kwh":"32"}',
    );
    expect(departureLabel(departure({ readiness: 'at_risk', shortfallKwh: 0 }), t).state).toBe(
      'fleets.departures.readiness.at_risk',
    );
    const cannot = departureLabel(departure({ readiness: 'cannot_meet', shortfallKwh: 80 }), t);
    expect(cannot.state).toBe('sites.layoutView.cannotMeetShort:{"kwh":"80"}');
    expect(cannot.color).toBe(stationStateTextColor('faulted'));
    expect(departureLabel(departure({ readiness: 'cannot_meet' }), t).state).toBe(
      'fleets.departures.readiness.cannot_meet',
    );
  });

  it('says the plan waits for the vehicle', () => {
    const l = departureLabel(departure({ readiness: 'waiting_for_vehicle' }), t);
    expect(l.state).toBe('fleets.departures.readiness.waiting_for_vehicle');
    expect(l.color).toBe(stationStateTextColor('available'));
  });
});

describe('departureTextColor', () => {
  it('wears the color of the matching station state', () => {
    expect(departureTextColor('at_risk')).toBe(stationStateTextColor('maintenance'));
    expect(departureTextColor(null)).toBeNull();
  });
});
