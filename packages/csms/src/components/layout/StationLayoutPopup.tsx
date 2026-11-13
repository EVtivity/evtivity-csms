// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The details of a station on the site Layout tab, the same in the 2D and the
// 3D view: the view places it beside the station (layout-popup-position.ts).

import { forwardRef, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CreditCard, MessageSquare, PlayCircle, X } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ConnectorStatusBadge } from '@/components/ConnectorStatusBadge';
import { StationStatusBadge } from '@/components/StationStatusBadge';
import { StationOnlineBadge } from '@/components/StationOnlineBadge';
import { useHasPermission } from '@/lib/auth';
import { useConnectorTypeLabel } from '@/hooks/use-connector-type-label';
import { formatEnergy, formatNumber } from '@/lib/formatting';
import { formatConnectorPowerKw } from '@/lib/connector-rating';
import { stationDisplayState } from '@/lib/station-display-state';
import type { LayoutStation } from './StationCard';
import type { LayoutTerminal } from './layout-terminals';
import { LayoutSimulatePanel } from './LayoutSimulatePanel';
import { layoutChargerName, layoutStationIdOf } from './site-layout-units';
import { screenPlainText } from './site-layout-screen-text';
import {
  ConnectionBadge,
  ConnectionTypeIcon,
  connectionTypeLabelKey,
  SignalBarsIcon,
} from './StationStateIcon';

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
    const typeLabel = useConnectorTypeLabel();
    const closeRef = useRef<HTMLButtonElement>(null);
    const simulateRef = useRef<HTMLButtonElement>(null);
    // The simulator screen slides over the details (simulator stations, stations:write).
    const [screen, setScreen] = useState<'details' | 'simulate'>('details');
    const backToDetails = useRef(false);
    const canSimulate = useHasPermission('stations:write') && station.isSimulator === true;
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

    useEffect(() => {
      if (screen === 'details' && backToDetails.current) {
        backToDetails.current = false;
        simulateRef.current?.focus({ preventScroll: true });
      }
    }, [screen]);
    // Another station selected: back to its details.
    useEffect(() => {
      setScreen('details');
    }, [station.id]);

    const state = stationDisplayState(station);
    const max = maxPowerKw(station);
    const energy = sessionEnergyWh(station);
    const reason =
      station.statusReason != null && (state === 'faulted' || state === 'unavailable')
        ? t(`stations.statusReason.${station.statusReason}`, station.statusReason)
        : null;
    const kind = t(KIND_LABEL_KEYS[stationKind(station)]);
    const connectionType = station.connectionType ?? null;
    // Wired stations show no signal.
    const signal = connectionType === 'cellular' ? (station.signal ?? null) : null;
    return (
      <div
        ref={ref}
        role="dialog"
        aria-label={t('sites.layoutView.detailsLabel', { id: layoutChargerName(station, t) })}
        data-testid="station-layout-popup"
        className="absolute z-[1000] max-h-[calc(100%-24px)] w-[280px] max-w-[calc(100%-24px)] overflow-y-auto overscroll-contain rounded-lg border bg-card p-4 text-card-foreground shadow-lg"
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
      >
        {screen === 'simulate' && canSimulate ? (
          <LayoutSimulatePanel
            station={station}
            onBack={() => {
              backToDetails.current = true;
              setScreen('details');
            }}
          />
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="flex items-center gap-1.5 text-base font-semibold">
                  <span className="truncate" data-testid="layout-popup-title">
                    {layoutChargerName(station, t)}
                  </span>
                  <ConnectionBadge station={station} />
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
              {/* The station status: the badge of the Stations list (owner rule 2026-11-02). */}
              <dd
                className="flex items-center justify-end gap-1.5"
                data-testid="layout-popup-status"
              >
                <StationStatusBadge status={station.status} statusReason={station.statusReason} />
                {!station.isOnline && <StationOnlineBadge isOnline={false} />}
              </dd>
              {reason != null && (
                <>
                  <dt className="text-muted-foreground">{t('sites.layoutView.reason')}</dt>
                  <dd className="text-right">{reason}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('sites.layoutView.power')}</dt>
              <dd className="text-right tabular-nums">
                {/* A unit charger: the live draw is the station's, so none shows for the unit. */}
                {currentDrawKw == null && station.unitCharger != null
                  ? '-'
                  : formatNumber(currentDrawKw ?? 0, 1)}{' '}
                / {max != null ? formatConnectorPowerKw(max) : '-'} kW
              </dd>
              {allocatedLimitKw != null && allocatedLimitKw > 0 && (
                <>
                  <dt className="text-muted-foreground">{t('sites.layoutView.allocatedLimit')}</dt>
                  <dd className="text-right tabular-nums">
                    {formatNumber(allocatedLimitKw, 1)} kW
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('sites.layoutView.sessionEnergy')}</dt>
              <dd className="text-right tabular-nums">
                {energy != null ? formatEnergy(energy) : t('sites.layoutView.noSession')}
              </dd>
              {connectionType != null && (
                <>
                  <dt className="text-muted-foreground">{t('sites.layoutView.connection')}</dt>
                  <dd
                    className="flex items-center justify-end gap-1.5"
                    data-testid="layout-connection"
                  >
                    <ConnectionTypeIcon type={connectionType} className="text-muted-foreground" />
                    <span>{station.networkType ?? t(connectionTypeLabelKey(connectionType))}</span>
                    {signal != null && (
                      <span
                        className="flex items-center gap-1 tabular-nums text-muted-foreground"
                        data-testid="layout-signal"
                        aria-label={t('sites.layoutView.connectionWithSignal', {
                          type: t(connectionTypeLabelKey(connectionType)),
                          bars: signal.bars,
                        })}
                      >
                        <SignalBarsIcon bars={signal.bars} className="text-foreground" />
                        {`${String(signal.dbm)} dBm`}
                      </span>
                    )}
                  </dd>
                </>
              )}
              {station.ocppVersion != null && (
                <>
                  <dt className="text-muted-foreground">{t('stations.ocppProtocol')}</dt>
                  <dd className="text-right" data-testid="layout-ocpp-version">
                    {station.ocppVersion}
                  </dd>
                </>
              )}
            </dl>
            {station.displayMessage != null && (
              <div
                className="mb-3 flex items-start gap-1.5 rounded-sm border border-primary/20 bg-primary/5 px-2 py-1.5"
                aria-label={t('sites.layoutView.displayMessage')}
              >
                <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 text-link" aria-hidden="true" />
                <p className="line-clamp-2 text-xs leading-tight text-link">
                  {station.displayMessage}
                </p>
              </div>
            )}
            {station.screenMessage != null && (
              <section
                className="mb-3 rounded-sm border bg-muted/50 px-2 py-1.5"
                aria-label={t('sites.layoutView.screenShows')}
                data-testid="layout-screen-message"
              >
                <p className="text-xs font-medium text-muted-foreground">
                  {t('sites.layoutView.screenShows')}
                </p>
                <p className="whitespace-pre-line text-sm leading-snug wrap-anywhere">
                  {screenPlainText(station.screenMessage.text)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('sites.layoutView.screenSourceLabel', {
                    source: t(`sites.layoutView.screenSource.${station.screenMessage.source}`),
                  })}
                </p>
              </section>
            )}
            <ul className="grid gap-1.5 border-t pt-2.5 text-sm">
              {station.evses.flatMap((evse) =>
                evse.connectors.map((conn) => (
                  <li
                    key={`${String(evse.evseId)}-${String(conn.connectorId)}`}
                    className="flex items-start justify-between gap-2"
                  >
                    <span className="shrink-0">
                      {t('sites.layoutView.evse', { id: evse.evseId })} ·{' '}
                      {typeLabel(conn.connectorType)}
                    </span>
                    {/* The status at the end: the badge of the connector views. */}
                    <span className="flex min-w-0 flex-wrap items-center justify-end gap-1 text-right text-muted-foreground">
                      {conn.maxPowerKw != null && (
                        <span>{formatConnectorPowerKw(conn.maxPowerKw)} kW</span>
                      )}
                      {conn.isPluggedIn && conn.energyDeliveredWh != null && (
                        <span>{formatEnergy(conn.energyDeliveredWh)}</span>
                      )}
                      <ConnectorStatusBadge status={conn.status} />
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
            <div className="mt-3 flex gap-2">
              <Link
                to={`/stations/${layoutStationIdOf(station.id)}`}
                className={cn(buttonVariants({ variant: 'outline' }), 'min-w-0 flex-1')}
              >
                {t('sites.layoutView.openStation')}
              </Link>
              {canSimulate && (
                <Button
                  ref={simulateRef}
                  type="button"
                  variant="outline"
                  className="min-w-0 flex-1"
                  data-testid="layout-simulate-open"
                  onClick={() => {
                    setScreen('simulate');
                  }}
                >
                  <PlayCircle className="h-4 w-4" aria-hidden="true" />
                  {t('sites.layoutView.simulate')}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    );
  },
);
