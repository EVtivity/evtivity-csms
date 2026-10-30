// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The details of a station on the site Layout tab, the same in the 2D and the
// 3D view: the view places it beside the station (layout-popup-position.ts).

import { forwardRef, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CreditCard, MessageSquare, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { useHasPermission } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { formatEnergy, formatNumber } from '@/lib/formatting';
import { formatConnectorPowerKw } from '@/lib/connector-rating';
import { stationDisplayState, stationStateLabelKey } from '@/lib/station-display-state';
import { useStationSim, type SignalGrade } from '@/components/sim/sim-connectivity';
import type { LayoutStation } from './StationCard';
import type { LayoutTerminal } from './layout-terminals';
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

function maxPowerKw(station: Pick<LayoutStation, 'evses'>): number | null {
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

const KIND_LABEL_KEYS = {
  dcFast: 'sites.layoutView.dcFast',
  level2: 'sites.levelL2',
  level1: 'sites.levelL1',
  ac: 'sites.layoutView.ac',
} as const;

/**
 * The charging kind: DC Fast for a DC station (the shared connector rule of
 * `@evtivity/lib/connector-power`, which the API applies), else Level 2 from
 * 7 kW and Level 1 below by the highest connector power, else AC.
 */
export function stationKind(
  station: Pick<LayoutStation, 'chargingKind' | 'evses'>,
): keyof typeof KIND_LABEL_KEYS {
  if (station.chargingKind === 'dc') return 'dcFast';
  const max = maxPowerKw(station);
  if (max != null && max >= 7) return 'level2';
  if (max != null && max > 0) return 'level1';
  return 'ac';
}

interface StationLayoutPopupProps {
  station: LayoutStation;
  currentDrawKw?: number | undefined;
  allocatedLimitKw?: number | null | undefined;
  /** Payment terminals paired to the station (only with paymentTerminals:read). */
  terminals?: readonly LayoutTerminal[] | undefined;
  onClose: () => void;
}

/**
 * The details of a station clicked in the 2D or the 3D layout. Escape and the
 * close button close it; focus moves to the close button when it opens and
 * back to where it was when it closes.
 */
export const StationLayoutPopup = forwardRef<HTMLDivElement, StationLayoutPopupProps>(
  function StationLayoutPopup(
    { station, currentDrawKw, allocatedLimitKw, terminals = [], onClose },
    ref,
  ) {
    const { t } = useTranslation();
    const canReadStations = useHasPermission('stations:read');
    const closeRef = useRef<HTMLButtonElement>(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => {
      onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      closeRef.current?.focus({ preventScroll: true });
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') onCloseRef.current();
      };
      window.addEventListener('keydown', onKey);
      return () => {
        window.removeEventListener('keydown', onKey);
        if (opener?.isConnected === true) opener.focus({ preventScroll: true });
      };
    }, []);

    const state = stationDisplayState(station);
    const max = maxPowerKw(station);
    const energy = sessionEnergyWh(station);
    const reason =
      station.statusReason != null && (state === 'faulted' || state === 'unavailable')
        ? t(`stations.statusReason.${station.statusReason}`, station.statusReason)
        : null;
    const kind = t(KIND_LABEL_KEYS[stationKind(station)]);
    return (
      <div
        ref={ref}
        role="dialog"
        aria-label={t('sites.layoutView.detailsLabel', { id: station.stationId })}
        data-testid="station-layout-popup"
        className="absolute z-[1000] max-h-[calc(100%-24px)] w-[280px] max-w-[calc(100%-24px)] overflow-y-auto overscroll-contain rounded-lg border bg-card p-4 text-card-foreground shadow-lg"
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
            ref={closeRef}
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
            {formatNumber(currentDrawKw ?? 0, 1)} /{' '}
            {max != null ? formatConnectorPowerKw(max) : '-'} kW
          </dd>
          {allocatedLimitKw != null && allocatedLimitKw > 0 && (
            <>
              <dt className="text-muted-foreground">{t('sites.layoutView.allocatedLimit')}</dt>
              <dd className="text-right tabular-nums">{formatNumber(allocatedLimitKw, 1)} kW</dd>
            </>
          )}
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
        {station.displayMessage != null && (
          <div
            className="mb-3 flex items-start gap-1.5 rounded border border-primary/20 bg-primary/5 px-2 py-1.5"
            aria-label={t('sites.layoutView.displayMessage')}
          >
            <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 text-link" aria-hidden="true" />
            <p className="line-clamp-2 text-xs leading-tight text-link">{station.displayMessage}</p>
          </div>
        )}
        <ul className="grid gap-1.5 border-t pt-2.5 text-sm">
          {station.evses.flatMap((evse) =>
            evse.connectors.map((conn) => (
              <li
                key={`${String(evse.evseId)}-${String(conn.connectorId)}`}
                className="flex items-start justify-between gap-2"
              >
                <span className="flex shrink-0 items-center gap-1.5">
                  <ConnectorStatusIcon
                    status={conn.status}
                    label={conn.connectorType ?? `#${String(conn.connectorId)}`}
                  />
                  <span>
                    {t('sites.layoutView.evse', { id: evse.evseId })} ·{' '}
                    {conn.connectorType ?? `#${String(conn.connectorId)}`}
                  </span>
                </span>
                <span className="min-w-0 text-right text-muted-foreground">
                  {conn.maxPowerKw != null
                    ? `${formatConnectorPowerKw(conn.maxPowerKw)} kW · `
                    : ''}
                  {conn.isPluggedIn && conn.energyDeliveredWh != null
                    ? `${formatEnergy(conn.energyDeliveredWh)} · `
                    : ''}
                  {t(`status.${conn.status}`, { defaultValue: conn.status })}
                </span>
              </li>
            )),
          )}
        </ul>
        {terminals.length > 0 && (
          <ul
            className="mt-2.5 grid gap-1.5 border-t pt-2.5 text-sm"
            aria-label={t('sites.layoutView.paymentTerminals')}
          >
            {terminals.map((terminal) => (
              <li key={terminal.id} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <CreditCard
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate">{terminal.name}</span>
                </span>
                <span className="shrink-0 text-right text-muted-foreground">
                  {terminal.evseNumber != null
                    ? `${t('sites.layoutView.evse', { id: terminal.evseNumber })} · `
                    : ''}
                  {terminal.online === true
                    ? t('status.online')
                    : terminal.online === false
                      ? t('status.offline')
                      : t('sites.layoutView.terminalStatusUnknown')}
                </span>
              </li>
            ))}
          </ul>
        )}
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
