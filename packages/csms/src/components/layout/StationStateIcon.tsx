// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Check,
  CheckCircle,
  Circle,
  Clock,
  Pause,
  Plug,
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
  type ConnectorIconName,
  type StationDisplayState,
} from '@/lib/station-display-state';

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
}: {
  state: StationDisplayState;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const Icon = STATION_ICONS[state];
  const label = t(stationStateLabelKey(state));
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

/** The 4G badge of a station with a cellular connection. */
export function CellularBadge(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <span
      title={t('sites.layoutView.cellularHint')}
      data-testid="cellular-badge"
      className="inline-flex shrink-0 items-center gap-0.5 rounded bg-foreground px-1 text-xs font-semibold leading-4 text-background"
    >
      <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
        <rect x="0" y="7" width="2" height="3" fill="currentColor" />
        <rect x="4" y="4" width="2" height="6" fill="currentColor" />
        <rect x="8" y="1" width="2" height="9" fill="currentColor" />
      </svg>
      <span aria-hidden="true">{t('sites.layoutView.cellularBadge')}</span>
      <span className="sr-only">{t('sites.layoutView.cellularHint')}</span>
    </span>
  );
}

/** The New tag of a station placed on a free spot but not saved yet. */
export function NewPlacementTag(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <span
      title={t('sites.layoutView.newTagHint')}
      data-testid="new-placement-tag"
      className="inline-flex shrink-0 items-center rounded-full bg-warning px-1.5 text-xs font-semibold leading-4 text-warning-foreground"
    >
      {t('sites.layoutView.newTag')}
    </span>
  );
}
