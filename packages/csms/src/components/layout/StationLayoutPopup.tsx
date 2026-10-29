// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { forwardRef } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { useHasPermission } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { formatEnergy, formatNumber } from '@/lib/formatting';
import { stationDisplayState, stationStateLabelKey } from '@/lib/station-display-state';
import { useStationSim, type SignalGrade } from '@/components/sim/sim-connectivity';
import type { LayoutStation } from './StationCard';
import { CellularBadge, ConnectorStatusIcon, StationStateIcon } from './StationStateIcon';

const GRADE_KEYS = {
  good: 'stations.sim.station.grade.good',
  fair: 'stations.sim.station.grade.fair',
  poor: 'stations.sim.station.grade.poor',
  unknown: 'stations.sim.station.grade.unknown',
} as const satisfies Record<SignalGrade, string>;

/** The signal grade of a cellular station, read from its SIM tab data when the popup opens. */
function CellularSignal({ stationId }: { stationId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const { data, isLoading } = useStationSim(stationId);
  if (isLoading) return <span>{t('common.loading')}</span>;
  const signal = data?.station?.dataLinks.find((link) => link.signal != null)?.signal ?? null;
  if (signal == null) return <span>{t('sites.layoutView.signalUnknown')}</span>;
  const reading =
    signal.dbm != null ? `${String(signal.dbm)} dBm` : `${String(signal.value)} ${signal.unit}`;
  return (
    <span>
      {t(GRADE_KEYS[signal.grade])} ({reading})
    </span>
  );
}

function maxPowerKw(station: LayoutStation): number | null {
  let max: number | null = null;
  for (const evse of station.evses) {
    for (const conn of evse.connectors) {
      if (conn.maxPowerKw != null && (max == null || conn.maxPowerKw > max)) max = conn.maxPowerKw;
    }
  }
  return max;
}

function sessionEnergyWh(station: LayoutStation): number | null {
  let total: number | null = null;
  for (const evse of station.evses) {
    for (const conn of evse.connectors) {
      if (conn.energyDeliveredWh != null) total = (total ?? 0) + conn.energyDeliveredWh;
    }
  }
  return total;
}

interface StationLayoutPopupProps {
  station: LayoutStation;
  currentDrawKw?: number | undefined;
  onClose: () => void;
}

/** The details of a station clicked in the 3D layout. */
export const StationLayoutPopup = forwardRef<HTMLDivElement, StationLayoutPopupProps>(
  function StationLayoutPopup({ station, currentDrawKw, onClose }, ref) {
    const { t } = useTranslation();
    const canReadStations = useHasPermission('stations:read');
    const state = stationDisplayState(station);
    const max = maxPowerKw(station);
    const energy = sessionEnergyWh(station);
    const reason =
      station.statusReason != null && (state === 'faulted' || state === 'unavailable')
        ? t(`stations.statusReason.${station.statusReason}`, station.statusReason)
        : null;
    const kind =
      station.chargingKind === 'dc' ? t('sites.layoutView.dcFast') : t('sites.layoutView.ac');
    return (
      <div
        ref={ref}
        role="dialog"
        aria-label={t('sites.layoutView.detailsLabel', { id: station.stationId })}
        data-testid="station-layout-popup"
        className="absolute z-20 w-[280px] max-w-[calc(100%-24px)] rounded-lg border bg-card p-4 text-card-foreground shadow-lg"
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-base font-semibold">
              <span className="truncate">{station.stationId}</span>
              {station.cellular && <CellularBadge />}
            </h3>
            <p className="text-xs text-muted-foreground">
              {station.model != null ? `${station.model} · ${kind}` : kind}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <dl className="my-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">{t('sites.layoutView.status')}</dt>
          <dd className="flex items-center justify-end gap-1.5">
            <StationStateIcon state={state} />
            <Badge variant="outline">{t(stationStateLabelKey(state))}</Badge>
          </dd>
          {reason != null && (
            <>
              <dt className="text-muted-foreground">{t('sites.layoutView.reason')}</dt>
              <dd className="text-right">{reason}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t('sites.layoutView.power')}</dt>
          <dd className="text-right tabular-nums">
            {formatNumber(currentDrawKw ?? 0, 1)} / {max != null ? formatNumber(max, 0) : '-'} kW
          </dd>
          <dt className="text-muted-foreground">{t('sites.layoutView.sessionEnergy')}</dt>
          <dd className="text-right tabular-nums">
            {energy != null ? formatEnergy(energy) : t('sites.layoutView.noSession')}
          </dd>
          <dt className="text-muted-foreground">{t('sites.layoutView.connection')}</dt>
          <dd className="text-right">
            {station.cellular ? (
              <span className="flex flex-col items-end">
                <span>{t('sites.layoutView.connectionCellular')}</span>
                {canReadStations && <CellularSignal stationId={station.id} />}
              </span>
            ) : (
              t('sites.layoutView.connectionWired')
            )}
          </dd>
        </dl>
        <ul className="grid gap-1.5 border-t pt-2.5 text-sm">
          {station.evses.flatMap((evse) =>
            evse.connectors.map((conn) => (
              <li
                key={`${String(evse.evseId)}-${String(conn.connectorId)}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <ConnectorStatusIcon
                    status={conn.status}
                    label={conn.connectorType ?? `#${String(conn.connectorId)}`}
                  />
                  <span className="truncate">
                    {t('sites.layoutView.evse', { id: evse.evseId })} ·{' '}
                    {conn.connectorType ?? `#${String(conn.connectorId)}`}
                  </span>
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {conn.maxPowerKw != null ? `${formatNumber(conn.maxPowerKw, 0)} kW · ` : ''}
                  {t(`status.${conn.status}`, { defaultValue: conn.status })}
                </span>
              </li>
            )),
          )}
        </ul>
        <Link
          to={`/stations/${station.id}`}
          className={cn(buttonVariants({ variant: 'outline' }), 'mt-3 w-full')}
        >
          {t('sites.layoutView.openStation')}
        </Link>
      </div>
    );
  },
);
