// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The departure label of a parked fleet vehicle on the 3D depot ("Departs
// 05:30" and "Ready 04:10", or "At Risk: 32 kWh Short"), shared by the label
// and the session popup. The readiness is null while the depot plan does not
// run: the label then shows the departure time only.

import type { TFunction } from 'i18next';
import { formatDepotTime } from '@/lib/depot-time';
import { formatNumber } from '@/lib/formatting';
import { stationStateTextColor, type StationDisplayState } from '@/lib/station-display-state';
import type { LayoutSessionDeparture } from './StationCard';

export interface DepartureLabel {
  /** "Departs 05:30" in the depot's time. */
  departs: string;
  /** The readiness line, or null while the plan does not run. */
  state: string | null;
  /** The readiness line's text color (a CSS color), or null while the plan does not run. */
  color: string | null;
}

/**
 * The station state whose color a readiness wears: ready like charging,
 * at risk like maintenance, cannot meet like faulted, waiting like available.
 */
const READINESS_STATION_STATE = {
  ready: 'charging',
  on_track: 'charging',
  at_risk: 'maintenance',
  cannot_meet: 'faulted',
  waiting_for_vehicle: 'available',
} as const satisfies Record<NonNullable<LayoutSessionDeparture['readiness']>, StationDisplayState>;

/**
 * The text color of a readiness on a card: the station state text color (the
 * state color mixed with the card foreground, at least 4.5:1 in both themes).
 */
export function departureTextColor(readiness: LayoutSessionDeparture['readiness']): string | null {
  return readiness == null ? null : stationStateTextColor(READINESS_STATION_STATE[readiness]);
}

export function departureLabel(departure: LayoutSessionDeparture, t: TFunction): DepartureLabel {
  const departs =
    departure.departureAt == null
      ? t('fleets.departures.asSoonAsPossible')
      : t('sites.layoutView.departs', {
          time: formatDepotTime(departure.departureAt, departure.timezone),
        });
  const short =
    departure.shortfallKwh != null && departure.shortfallKwh > 0
      ? formatNumber(departure.shortfallKwh, 0)
      : null;
  let state: string | null = null;
  switch (departure.readiness) {
    case 'ready':
    case 'on_track':
      state =
        departure.predictedReadyAt != null
          ? t('sites.layoutView.readyAt', {
              time: formatDepotTime(departure.predictedReadyAt, departure.timezone),
            })
          : t('fleets.departures.readiness.ready');
      break;
    case 'at_risk':
      state =
        short != null
          ? t('sites.layoutView.atRiskShort', { kwh: short })
          : t('fleets.departures.readiness.at_risk');
      break;
    case 'cannot_meet':
      state =
        short != null
          ? t('sites.layoutView.cannotMeetShort', { kwh: short })
          : t('fleets.departures.readiness.cannot_meet');
      break;
    case 'waiting_for_vehicle':
      state = t('fleets.departures.readiness.waiting_for_vehicle');
      break;
    default:
      state = null;
  }
  return { departs, state, color: departureTextColor(departure.readiness) };
}
