// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The state an EVSE's own status light shows on its number plate in the 3D
// layout (site-layout-model-evse-plate.ts), and the plate's hover label.

import type { TFunction } from 'i18next';
import { evseDisplayState, type StationDisplayState } from '@/lib/station-display-state';
import { connectorFlows } from './site-layout-cable';
import { connectorTypeLabel } from '@evtivity/lib/connector-type-label';

/** Station states that hold every EVSE of the station (the whole station is in them). */
const STATION_WIDE: ReadonlySet<StationDisplayState> = new Set([
  'maintenance',
  'unavailable',
  'offline',
]);

/**
 * The state of one EVSE's light: the station's own state while the whole
 * station is faulted (its status, not a connector), in maintenance,
 * unavailable or offline, else the EVSE's own (`evseDisplayState`: a faulted
 * connector turns only its EVSE's light red). It pulses while a connector of
 * the EVSE charges or discharges, and blinks while faulted.
 */
export function evseLampState(
  station: { status: string | null; state: StationDisplayState },
  evse: {
    connectors: ReadonlyArray<{ status: string; isPluggedIn?: boolean | undefined }>;
  },
): { state: StationDisplayState; pulsing: boolean; blinking: boolean } {
  const state =
    station.status === 'faulted'
      ? 'faulted'
      : STATION_WIDE.has(station.state)
        ? station.state
        : evseDisplayState(evse);
  return {
    state,
    pulsing: state === 'charging' && evse.connectors.some((c) => connectorFlows(c.status)),
    blinking: state === 'faulted',
  };
}

/**
 * The hover label of an EVSE plate: "EVSE 1, CCS1 and CHAdeMO", the
 * connector types of the EVSE once each, joined in the viewer's language.
 */
export function evsePlateLabel(
  t: TFunction,
  locale: string,
  evse: { evseId: number; connectors: ReadonlyArray<{ connectorType: string | null }> },
): string {
  const words = {
    other: t('connectorTypeNames.other'),
    pantograph: t('connectorTypeNames.pantograph'),
  };
  const names = [
    ...new Set(evse.connectors.map((c) => connectorTypeLabel(c.connectorType, words))),
  ];
  let types = names.join(', ');
  try {
    types = new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);
  } catch {
    // fail-open: a locale the runtime does not know keeps the comma list
  }
  return t('sites.layoutView.evsePlateHover', { n: evse.evseId, types });
}
