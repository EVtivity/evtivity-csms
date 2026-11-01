// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Check,
  CheckCircle,
  Circle,
  Clock,
  EthernetPort,
  Network,
  Pause,
  Plug,
  RadioTower,
  Wifi,
  Wrench,
  XCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  connectorIconName,
  connectorStatusColor,
  stationStateColor,
  stationStateLabelKey,
  STATION_DISPLAY_STATES,
  type ConnectorIconName,
  type StationDisplayState,
} from '@/lib/station-display-state';
import type { LayoutStation } from './StationCard';
import type { LayoutConnectionType } from './site-layout-legend';

const STATION_ICONS: Record<StationDisplayState, LucideIcon> = {
  faulted: AlertCircle,
  unavailable: XCircle,
  maintenance: Wrench,
  offline: XCircle,
  reserved: Clock,
  charging: Zap,
  available: Check,
  online: CheckCircle,
};

const CONNECTOR_ICONS: Record<ConnectorIconName, LucideIcon> = {
  check: Check,
  zap: Zap,
  plug: Plug,
  clock: Clock,
  pause: Pause,
  alert: AlertCircle,
  x: XCircle,
  none: Circle,
};

/** The icon of a station state, in its color, with a translated label. */
export function StationStateIcon({
  state,
  className,
  decorative = false,
}: {
  state: StationDisplayState;
  className?: string;
  /** No label of its own: the element around it names the state. */
  decorative?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const Icon = STATION_ICONS[state];
  const label = t(stationStateLabelKey(state));
  if (decorative) {
    return (
      <Icon
        aria-hidden="true"
        className={cn('h-3.5 w-3.5 shrink-0', className)}
        style={{ color: stationStateColor(state) }}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-state={state}
      className="inline-flex shrink-0"
    >
      <Icon
        aria-hidden="true"
        className={cn('h-3.5 w-3.5', className)}
        style={{ color: stationStateColor(state) }}
      />
    </span>
  );
}

/**
 * A status marker as the 3D view draws it: the state icon in its color on a
 * solid white round background in both themes, no border or ring. The 2D card, its EVSEs and the legend show this marker
 * (owner decision 2026-11-01: 2D and 3D use the same status markers).
 */
export function StateBadge({
  state,
  label,
}: {
  state: StationDisplayState;
  /** A label of its own (an EVSE), else the state's name. */
  label?: string | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const text = label ?? t(stationStateLabelKey(state));
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      data-state={state}
      data-testid="state-badge"
      className="inline-flex shrink-0 rounded-full bg-white p-0.5 shadow-[0_0_2px_rgb(0_0_0/0.35)]"
    >
      <StationStateIcon state={state} decorative />
    </span>
  );
}

/**
 * The legend of the station states: each state's icon in its color with its
 * name, the marker every station shows on the 3D layout and the 2D cards,
 * on the solid white round background of the 3D badges. Only the states the
 * site shows or can reach (`layoutLegend`). The virtual Reserved and
 * Maintenance signs carry their own text and are not in the legend (owner
 * decision 2026-11-01); their marker icons are, once each.
 */
export function StationStateLegend({
  states = STATION_DISPLAY_STATES,
}: {
  states?: readonly StationDisplayState[];
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {states.map((state) => (
        <span
          key={state}
          className="flex items-center gap-1"
          data-testid={`station-state-legend-${state}`}
        >
          <StateBadge state={state} /> {t(stationStateLabelKey(state))}
        </span>
      ))}
    </>
  );
}

/** The icon of a connector status (design spec mapping), with a translated label. */
export function ConnectorStatusIcon({
  status,
  label,
  className,
}: {
  status: string;
  /** Text before the status, such as the connector type. */
  label?: string | undefined;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const Icon = CONNECTOR_ICONS[connectorIconName(status)];
  const statusLabel = t(`status.${status}`, { defaultValue: status });
  const text = label != null ? `${label}: ${statusLabel}` : statusLabel;
  return (
    <span role="img" aria-label={text} title={text} data-status={status} className="inline-flex">
      <Icon
        aria-hidden="true"
        className={cn('h-3.5 w-3.5', className)}
        style={{ color: connectorStatusColor(status) }}
      />
    </span>
  );
}

/** What the layout knows of a station's connection (the layout reply fields). */
export type StationConnection = Pick<LayoutStation, 'connectionType' | 'signal'>;

/** Four signal bars, the first `bars` filled (0 to 4). */
export function SignalBarsIcon({
  bars,
  className,
}: {
  bars: number;
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 14 12"
      aria-hidden="true"
      data-bars={bars}
      className={cn('h-3 w-3.5 shrink-0', className)}
    >
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={i * 3.5}
          y={9 - i * 3}
          width="2.5"
          height={3 + i * 3}
          rx="0.5"
          fill="currentColor"
          opacity={i < bars ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}

/** The i18n key of a connection type's name. */
export function connectionTypeLabelKey(
  type: LayoutConnectionType,
):
  | 'dataPlan.plans.cellular'
  | 'dataPlan.plans.wifi_or_wired'
  | 'sites.layoutView.connectionWifi'
  | 'sites.layoutView.connectionWired' {
  switch (type) {
    case 'cellular':
      return 'dataPlan.plans.cellular';
    case 'wifi':
      return 'sites.layoutView.connectionWifi';
    case 'wired':
      return 'sites.layoutView.connectionWired';
    case 'wifi_or_wired':
      return 'dataPlan.plans.wifi_or_wired';
  }
}

const CONNECTION_ICONS: Record<LayoutConnectionType, LucideIcon> = {
  cellular: RadioTower,
  wifi: Wifi,
  wired: EthernetPort,
  wifi_or_wired: Network,
};

/** The icon of a connection type (the same on the stations, in the popup and in the legend). */
export function ConnectionTypeIcon({
  type,
  className,
}: {
  type: LayoutConnectionType;
  className?: string;
}): React.JSX.Element {
  const Icon = CONNECTION_ICONS[type];
  return (
    <Icon
      aria-hidden="true"
      data-connection-icon={type}
      className={cn('h-3.5 w-3.5 shrink-0', className)}
    />
  );
}

/**
 * A station's connection: the connection type icon, and the signal bars next
 * to it when the station reported a strength. Nothing when the type is unknown.
 */
export function ConnectionBadge({
  station,
}: {
  station: StationConnection;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const type = station.connectionType ?? null;
  if (type == null) return null;
  const typeLabel = t(connectionTypeLabelKey(type));
  const signal = type === 'cellular' ? (station.signal ?? null) : null;
  const label =
    signal != null
      ? t('sites.layoutView.connectionWithSignal', { type: typeLabel, bars: signal.bars })
      : typeLabel;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="connection-badge"
      data-connection={type}
      className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground"
    >
      <ConnectionTypeIcon type={type} />
      {signal != null && <SignalBarsIcon bars={signal.bars} className="text-foreground" />}
    </span>
  );
}

/**
 * Legend entries for the connection types the site's stations have (as the
 * other legend entries, only what the view draws): Cellular, the signal bars
 * when a station reported one, Wi-Fi, Wired, and Wi-Fi or Wired for a station
 * that reported no active network interface.
 */
export function ConnectionLegend({
  types,
  signal,
}: {
  types: readonly LayoutConnectionType[];
  signal: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {types.map((type) => (
        <span key={type} className="contents">
          <span className="flex items-center gap-1" data-testid={`connection-legend-${type}`}>
            <ConnectionTypeIcon type={type} /> {t(connectionTypeLabelKey(type))}
          </span>
          {type === 'cellular' && signal && (
            <span
              className="flex items-center gap-1"
              data-testid="connection-legend-signal"
              title={t('sites.layoutView.signalLegendHint')}
            >
              <SignalBarsIcon bars={4} className="text-foreground" />{' '}
              {t('sites.layoutView.signalLegend')}
            </span>
          )}
        </span>
      ))}
    </>
  );
}
