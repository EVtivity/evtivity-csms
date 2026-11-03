// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The content of the standard 2D charger card, the same on every site
// type's board (owner design 2026-11-03), in three rows on one 12 px gutter:
// - header: the station ID, then its connection and payment terminal icons;
// - body: the picture of its 3D model, one status badge (Offline replaces
//   the state while offline) and one metrics line (power and energy while
//   charging, the fault reason when faulted, else the station's top power);
// - footer: every port as its connector face icon in its status color,
//   grouped by EVSE, no "EVSE n" labels (each icon's name carries the EVSE).
// Status color appears only in the card's accent bar, the badge and the port
// icons; everything else is neutral.

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatEnergy, formatNumber } from '@/lib/formatting';
import { ConnectorTypeIcon } from '@/components/ConnectorTypeIcon';
import { CONNECTOR_KIND_NAMES } from '@/components/connector-icons/connector-kind-name';
import { StationStatusBadge } from '@/components/StationStatusBadge';
import { StationOnlineBadge } from '@/components/StationOnlineBadge';
import { ConnectionBadge } from './StationStateIcon';
import { PaymentTerminalBadge } from './PaymentTerminalBadge';
import { StationThumbnail } from './StationThumbnail';
import { connectorKindOf } from './site-layout-connectors';
import { useStationCardExtras } from './station-card-context';
import type { LayoutStation } from './StationCard';

function totalEnergy(station: LayoutStation): number {
  let total = 0;
  for (const evse of station.evses) {
    for (const conn of evse.connectors) total += conn.energyDeliveredWh ?? 0;
  }
  return total;
}

/** The station's top power: its fastest connector, in kW (null when none reports one). */
export function stationMaxPowerKw(station: Pick<LayoutStation, 'evses'>): number | null {
  let max: number | null = null;
  for (const evse of station.evses) {
    for (const c of evse.connectors) {
      if (c.maxPowerKw != null && c.maxPowerKw > (max ?? 0)) max = c.maxPowerKw;
    }
  }
  return max;
}

function Metrics({
  station,
  currentDrawKw,
}: {
  station: LayoutStation;
  currentDrawKw?: number | undefined;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const charging = station.evses.some((e) => e.connectors.some((c) => c.isPluggedIn));
  const energy = totalEnergy(station);
  const drawing = currentDrawKw != null && currentDrawKw > 0;
  if (station.status === 'faulted' && station.statusReason != null) {
    return (
      <p
        className="max-w-full truncate text-xs text-muted-foreground"
        data-testid="station-card-metrics"
      >
        {t(`stations.statusReason.${station.statusReason}`, station.statusReason)}
      </p>
    );
  }
  if (charging && (drawing || energy > 0)) {
    return (
      <p className="max-w-full truncate text-xs tabular-nums" data-testid="station-card-metrics">
        {drawing && <span className="text-foreground">{formatNumber(currentDrawKw, 1)} kW</span>}
        {drawing && energy > 0 && <span className="text-muted-foreground"> · </span>}
        {energy > 0 && <span className="text-muted-foreground">{formatEnergy(energy)}</span>}
      </p>
    );
  }
  const max = stationMaxPowerKw(station);
  if (max == null) return null;
  return (
    <p
      className="max-w-full truncate text-xs tabular-nums text-muted-foreground"
      data-testid="station-card-metrics"
    >
      {t('sites.layoutView.upToKw', { kw: formatNumber(max, max % 1 === 0 ? 0 : 1) })}
    </p>
  );
}

export function StationCardContent({
  station,
  currentDrawKw,
}: {
  station: LayoutStation;
  currentDrawKw?: number | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const extras = useStationCardExtras();
  const dc = station.chargingKind === 'dc';
  const evses = [...station.evses].sort((a, b) => a.evseId - b.evseId);
  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 flex-1 truncate text-sm leading-4 font-semibold tabular-nums"
          title={station.stationId}
          data-testid="station-card-id"
        >
          {station.stationId}
        </span>
        <span
          className="flex shrink-0 items-center gap-1 [&_svg]:h-3.5 [&_svg]:w-3.5"
          data-testid="station-card-links"
        >
          {station.connectionType != null && <ConnectionBadge station={station} />}
          <PaymentTerminalBadge terminals={extras.terminals(station.id)} />
        </span>
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <span className={cn('self-end', !station.isOnline && 'opacity-50 grayscale')}>
          <StationThumbnail model={extras.thumbnailModel(station)} dc={dc} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          {/* One badge: the Stations list status, or Offline in its place while offline. */}
          <div data-testid="station-card-status">
            {station.isOnline ? (
              <StationStatusBadge
                status={station.status}
                statusReason={station.statusReason}
                size="sm"
              />
            ) : (
              <StationOnlineBadge isOnline={false} size="sm" />
            )}
          </div>
          <Metrics station={station} currentDrawKw={currentDrawKw} />
        </div>
      </div>

      {/* Every port: its connector face icon in the connector status color (owner rule 2026-11-02). */}
      <ul
        className="flex items-center gap-2.5 overflow-hidden border-t pt-0.5"
        data-testid="station-card-evses"
      >
        {evses.map((evse) => (
          <li
            key={evse.evseId}
            className="flex shrink-0 items-center gap-1"
            data-testid={`station-card-evse-${String(evse.evseId)}`}
          >
            {evse.connectors.map((c) => (
              <ConnectorTypeIcon
                key={c.connectorId}
                type={c.connectorType}
                status={c.status}
                dc={dc}
                size={20}
                label={t('sites.layoutView.portIconLabel', {
                  n: evse.evseId,
                  type: CONNECTOR_KIND_NAMES[connectorKindOf(c.connectorType, dc)],
                  state: t(`status.${c.status}`, { defaultValue: c.status }),
                })}
              />
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
