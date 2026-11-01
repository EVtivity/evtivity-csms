// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The one state a station shows on the site layout (2D cards, 3D view, popup):
// the most severe state first. Icons and colors follow the status indicator
// mapping of the CSMS design spec (section 12) and STATUS_COLORS.

import { STATUS_COLORS } from '@/lib/chart-theme';

/** Station states, most severe first. */
export const STATION_DISPLAY_STATES = [
  'faulted',
  'maintenance',
  'unavailable',
  'offline',
  'reserved',
  'charging',
  'available',
  'online',
] as const;
export type StationDisplayState = (typeof STATION_DISPLAY_STATES)[number];

export interface DisplayStateInput {
  /** Derived station status of the layout response. */
  status: string | null;
  isOnline: boolean;
  inMaintenance?: boolean | undefined;
  evses: ReadonlyArray<{ connectors: ReadonlyArray<{ status: string }> }>;
}

/**
 * faulted (station status faulted or any connector faulted) > maintenance (an
 * active maintenance event) > unavailable (station status unavailable:
 * disabled, firmware install, station-reported) > offline > reserved (status
 * reserved or any reserved connector) > charging > available > online (an
 * online station whose status is unknown, such as one without connectors).
 *
 * Maintenance comes before unavailable and offline (owner decision
 * 2026-11-01): a maintenance window sets its stations Inoperative
 * (ChangeAvailability, `maintenance.service.ts`), so they report Unavailable,
 * and a technician may power one off. Both are the expected effect of the
 * window, and the operator needs to see that the station is in maintenance,
 * not a second state the window explains. A fault still wins: the window does
 * not explain a fault, and a fault needs attention even during maintenance.
 */
export function stationDisplayState(station: DisplayStateInput): StationDisplayState {
  const connectorStatuses = station.evses.flatMap((e) => e.connectors.map((c) => c.status));
  if (station.status === 'faulted' || connectorStatuses.includes('faulted')) return 'faulted';
  if (station.inMaintenance === true) return 'maintenance';
  if (station.status === 'unavailable') return 'unavailable';
  if (!station.isOnline) return 'offline';
  if (station.status === 'reserved' || connectorStatuses.includes('reserved')) return 'reserved';
  if (station.status === 'charging') return 'charging';
  if (station.status === 'available') return 'available';
  return 'online';
}

/** Connector statuses of an EVSE in use (a car plugged in or a session running). */
const EVSE_IN_USE = new Set([
  'occupied',
  'charging',
  'discharging',
  'preparing',
  'ev_connected',
  'suspended_ev',
  'suspended_evse',
  'idle',
  'finishing',
]);

/**
 * The state one EVSE of a station shows on its 2D card, with the same marker
 * set as the station (owner decision 2026-11-01: 2D and 3D use the same
 * status markers): faulted > unavailable > reserved > charging (a car plugged
 * in or a connector in use) > available > online (status unknown).
 */
export function evseDisplayState(evse: {
  connectors: ReadonlyArray<{ status: string; isPluggedIn?: boolean | undefined }>;
}): StationDisplayState {
  const statuses = evse.connectors.map((c) => c.status.toLowerCase());
  if (statuses.includes('faulted')) return 'faulted';
  if (statuses.length > 0 && statuses.every((s) => s === 'unavailable')) return 'unavailable';
  if (statuses.includes('reserved')) return 'reserved';
  if (
    evse.connectors.some((c) => c.isPluggedIn === true) ||
    statuses.some((s) => EVSE_IN_USE.has(s))
  )
    return 'charging';
  if (statuses.includes('available')) return 'available';
  return 'online';
}

/** The i18n key of a station state label. */
export function stationStateLabelKey(
  state: StationDisplayState,
): `sites.layoutState.${StationDisplayState}` {
  return `sites.layoutState.${state}`;
}

/**
 * The color of a station state: STATUS_COLORS for the connector palette
 * states, theme tokens (as CSS colors) for maintenance, offline and online.
 */
export function stationStateColor(state: StationDisplayState): string {
  switch (state) {
    case 'faulted':
      return STATUS_COLORS['faulted'] ?? 'hsl(var(--destructive))';
    case 'unavailable':
      return STATUS_COLORS['unavailable'] ?? 'hsl(var(--destructive))';
    case 'maintenance':
      return 'hsl(var(--warning))';
    case 'offline':
      return 'hsl(var(--muted-foreground))';
    case 'reserved':
      return STATUS_COLORS['reserved'] ?? 'hsl(var(--warning))';
    case 'charging':
      return STATUS_COLORS['charging'] ?? 'hsl(var(--success))';
    case 'available':
      return STATUS_COLORS['available'] ?? 'hsl(var(--success))';
    case 'online':
      return 'hsl(var(--success))';
  }
}

/** Percent of the state color in the state text color; the rest is the card foreground. */
export const STATION_STATE_TEXT_MIX = 60;

/**
 * The state color as text on a card (the 3D layout labels): the state color
 * mixed with the card foreground, so it keeps its hue and reads at least 4.5:1
 * on the card in both themes (`station-state-text-contrast.test.ts`).
 */
export function stationStateTextColor(state: StationDisplayState): string {
  return `color-mix(in srgb, ${stationStateColor(state)} ${String(STATION_STATE_TEXT_MIX)}%, hsl(var(--card-foreground)))`;
}

/** Connector status icon names of the design spec mapping. */
export type ConnectorIconName =
  | 'check'
  | 'zap'
  | 'plug'
  | 'clock'
  | 'pause'
  | 'alert'
  | 'x'
  | 'none';

export function connectorIconName(status: string): ConnectorIconName {
  switch (status) {
    case 'available':
      return 'check';
    case 'occupied':
    case 'charging':
    case 'discharging':
      return 'zap';
    case 'preparing':
    case 'ev_connected':
      return 'plug';
    case 'reserved':
      return 'clock';
    case 'suspended_ev':
    case 'suspended_evse':
    case 'idle':
      return 'pause';
    case 'faulted':
      return 'alert';
    case 'unavailable':
      return 'x';
    default:
      return 'none';
  }
}

/** The color of a connector status (STATUS_COLORS, muted for unknown ones). */
export function connectorStatusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'hsl(var(--muted-foreground))';
}

/**
 * A theme token (`--warning`) as a CSS color a non-CSS renderer can parse:
 * `hsl(37.7, 92.1%, 50.2%)`. A color that is not a token comes back as is.
 */
export function resolveCssColor(color: string): string {
  const match = /^hsl\(var\((--[a-z-]+)\)\)$/.exec(color);
  if (match == null || typeof document === 'undefined') return color;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(match[1] ?? '')
    .trim();
  if (value === '') return '#6b7280';
  return `hsl(${value.split(/\s+/).join(', ')})`;
}
