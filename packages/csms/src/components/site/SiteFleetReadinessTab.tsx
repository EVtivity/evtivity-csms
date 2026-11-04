// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Fleet Readiness tab of a Depot site: the departures of the depot with
// their vehicles' stations, the sessions no vehicle is bound to, and, while
// planning is on (the fleet charging setting on and the site on the Departure
// Aware strategy), the readiness per departure, the plan chart and
// Recalculate. Departure details need fleets:read (the API leaves them out).

import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { VehicleBodyType } from '@evtivity/lib/vehicle-appearance';
import { Car, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TabPanel } from '@/components/ui/tab-panel';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { EmptyState, LoadingState, TableStateRow } from '@/components/ui/content-state';
import { RecalculateButton } from '@/components/recalculate-button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatDepotDateTime, formatDepotTime } from '@/lib/depot-time';
import { formatNumber } from '@/lib/formatting';
import { AssignVehicleDialog, type UnidentifiedSession } from './AssignVehicleDialog';
import { DepartureSourceBadge } from '../fleet/DepartureSourceBadge';
import {
  READINESS_STATES,
  cancelReasonLabel,
  deliveredOfTarget,
  departureTimeLabel,
  readinessVariant,
  siteChargingPlanKey,
  targetWithMaxLabel,
  vehicleLabel,
  type Departure,
  type FleetVehicleOption,
} from '../fleet/departure-types';

export interface SiteChargingPlan {
  planning: boolean;
  notPlanningReason: 'fleet_charging_disabled' | 'strategy' | null;
  bufferMinutes: number;
  computedAt: string | null;
  staleAt: string | null;
  slotStarts: string[] | null;
  plan: unknown;
  capacityKw: unknown[] | null;
  pricePerKwh: unknown[] | null;
  /** Which departures the reply lists (`departureStatus` of the request). */
  departureStatus?: ReadinessDepartureStatus;
  /** Absent without fleets:read. */
  departures?: Departure[];
  /** sessionId is left out without sessions:read: such a row cannot be assigned. */
  unidentifiedSessions: Array<Omit<UnidentifiedSession, 'sessionId'> & { sessionId?: string }>;
}

const NOT_PLANNED = '-';

/** The departures the view lists: scheduled ones, or the cancelled ones of the last 7 days. */
export type ReadinessDepartureStatus = 'scheduled' | 'cancelled';
const READINESS_DEPARTURE_STATUSES: readonly ReadinessDepartureStatus[] = [
  'scheduled',
  'cancelled',
];

// ApexCharts loads only when a plan chart shows, not with the site page.
const ChargingPlanChart = lazy(async () => ({
  default: (await import('./ChargingPlanChart')).ChargingPlanChart,
}));

interface SiteFleetReadinessTabProps {
  siteId: string;
  /** The site's time zone: departure times show at the depot. */
  timezone: string | null;
}

export function SiteFleetReadinessTab({
  siteId,
  timezone,
}: SiteFleetReadinessTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const canRecalculate = useHasPermission('loadManagement:write');
  const canAssign = useHasPermission('sessions:write');
  const [assignSession, setAssignSession] = useState<UnidentifiedSession | null>(null);
  const [departureStatus, setDepartureStatus] = useState<ReadinessDepartureStatus>('scheduled');
  const cancelledView = departureStatus === 'cancelled';

  const query = useQuery({
    queryKey: [...siteChargingPlanKey(siteId), departureStatus],
    queryFn: () =>
      api.get<SiteChargingPlan>(
        cancelledView
          ? `/v1/sites/${siteId}/charging-plan?departureStatus=cancelled`
          : `/v1/sites/${siteId}/charging-plan`,
      ),
    refetchInterval: 30_000,
  });
  const view = query.data;

  const recalculate = useMutation({
    mutationFn: () => api.post(`/v1/sites/${siteId}/charging-plan/recalculate`, {}),
    onSuccess: () => {
      toast({ title: t('sites.fleetReadiness.recalculateQueued'), variant: 'success' });
    },
    onError: (err: unknown) => {
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });

  const departures = view?.departures;
  const planning = view?.planning === true;
  // Cancelled rows carry no readiness.
  const showReadiness = planning && !cancelledView;
  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of departures ?? []) map.set(d.id, vehicleLabel(d.vehicle));
    return map;
  }, [departures]);
  const labelOf = useCallback(
    (departureId: string, index: number) =>
      labels.get(departureId) ?? t('sites.fleetReadiness.vehicleN', { n: index + 1 }),
    [labels, t],
  );
  const depotVehicles = useMemo<FleetVehicleOption[]>(() => {
    const seen = new Map<string, FleetVehicleOption>();
    for (const d of departures ?? []) {
      if (d.vehicle != null && !seen.has(d.vehicle.id)) seen.set(d.vehicle.id, d.vehicle);
    }
    return [...seen.values()];
  }, [departures]);
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const d of departures ?? []) {
      if (d.readiness != null) out.set(d.readiness, (out.get(d.readiness) ?? 0) + 1);
    }
    return out;
  }, [departures]);
  // The chart and its horizon start at the time the plan was read.
  const nowMs = query.dataUpdatedAt;

  const columns = 10;
  return (
    <>
      <TabPanel
        title={t('sites.fleetReadiness.title')}
        description={t('sites.fleetReadiness.description')}
        actions={
          planning && canRecalculate ? (
            <RecalculateButton
              label={t('sites.fleetReadiness.recalculate')}
              disabled={recalculate.isPending}
              onClick={() => {
                recalculate.mutate();
              }}
            />
          ) : undefined
        }
        bodyClassName="space-y-4"
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => {
          void query.refetch();
        }}
      >
        {view != null && !planning && (
          <Alert variant="info" data-testid="fleet-readiness-not-planning">
            <Info />
            <AlertDescription>
              {view.notPlanningReason === 'strategy'
                ? t('sites.fleetReadiness.notPlanningStrategy')
                : t('sites.fleetReadiness.notPlanningSetting')}
            </AlertDescription>
          </Alert>
        )}

        {showReadiness && departures != null && (
          <div className="flex flex-wrap gap-2" data-testid="fleet-readiness-summary">
            {READINESS_STATES.map((state) => (
              <Badge key={state} variant={readinessVariant(state)}>
                {t(`fleets.departures.readiness.${state}`)}: {String(counts.get(state) ?? 0)}
              </Badge>
            ))}
          </div>
        )}

        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={t('fleets.departures.statusFilter')}
        >
          {READINESS_DEPARTURE_STATUSES.map((status) => (
            <Button
              key={status}
              type="button"
              variant={departureStatus === status ? 'default' : 'outline'}
              aria-pressed={departureStatus === status}
              onClick={() => {
                setDepartureStatus(status);
              }}
            >
              {t(`fleets.departures.statuses.${status}`)}
            </Button>
          ))}
        </div>

        {departures == null ? (
          <EmptyState>{t('sites.fleetReadiness.noFleetAccess')}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('fleets.departures.departure')}</TableHead>
                  <TableHead>{t('fleets.departures.source')}</TableHead>
                  <TableHead>{t('fleets.departures.vehicle')}</TableHead>
                  <TableHead>{t('vehicles.bodyType')}</TableHead>
                  <TableHead>{t('sites.fleetReadiness.stationEvse')}</TableHead>
                  <TableHead>{t('fleets.departures.target')}</TableHead>
                  <TableHead>{t('fleets.departures.state')}</TableHead>
                  <TableHead>{t('fleets.departures.delivered')}</TableHead>
                  <TableHead>{t('fleets.departures.predictedReady')}</TableHead>
                  <TableHead>{t('fleets.departures.reason')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {departures.length === 0 && (
                  <TableStateRow colSpan={columns}>
                    <EmptyState>
                      {cancelledView
                        ? t('sites.fleetReadiness.noCancelledDepartures')
                        : t('sites.fleetReadiness.noDepartures')}
                    </EmptyState>
                  </TableStateRow>
                )}
                {departures.map((d) => (
                  <TableRow key={d.id} data-testid={`readiness-row-${d.id}`}>
                    <TableCell>
                      <div className="whitespace-nowrap">{departureTimeLabel(t, d, timezone)}</div>
                      {d.expectedArrivalAt != null && (
                        <div className="text-xs text-muted-foreground whitespace-nowrap">
                          {d.expectedArrivalSocPercent != null
                            ? t('fleets.departures.expectedArrivalWithSoc', {
                                time: formatDepotTime(d.expectedArrivalAt, timezone),
                                soc: `${formatNumber(d.expectedArrivalSocPercent, 0)}%`,
                              })
                            : t('fleets.departures.expectedArrival', {
                                time: formatDepotTime(d.expectedArrivalAt, timezone),
                              })}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <DepartureSourceBadge departure={d} />
                    </TableCell>
                    <TableCell className="wrap-anywhere">{vehicleLabel(d.vehicle)}</TableCell>
                    <TableCell>
                      {d.vehicle?.bodyType != null
                        ? t(`vehicles.bodyTypes.${d.vehicle.bodyType as VehicleBodyType}`)
                        : NOT_PLANNED}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {d.station != null
                        ? d.station.evseId != null
                          ? t('sites.fleetReadiness.stationWithEvse', {
                              station: d.station.stationId,
                              evse: d.station.evseId,
                            })
                          : d.station.stationId
                        : t('fleets.departures.reasons.not_plugged_in')}
                      {d.station == null && d.requestedEvseId != null && (
                        <div
                          className="text-xs text-muted-foreground"
                          data-testid={`readiness-requested-${d.id}`}
                        >
                          {d.requestedChargingPointId != null
                            ? t('fleets.departures.requestedChargingPointNamed', {
                                point: d.requestedChargingPointId,
                              })
                            : t('fleets.departures.requestedChargingPoint')}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{targetWithMaxLabel(t, d)}</TableCell>
                    <TableCell>
                      {d.status === 'cancelled' ? (
                        <Badge variant="outline">{t('fleets.departures.statuses.cancelled')}</Badge>
                      ) : showReadiness && d.readiness != null ? (
                        <Badge variant={readinessVariant(d.readiness)}>
                          {t(`fleets.departures.readiness.${d.readiness}`)}
                        </Badge>
                      ) : (
                        NOT_PLANNED
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{deliveredOfTarget(t, d)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {showReadiness && d.predictedReadyAt != null
                        ? formatDepotTime(d.predictedReadyAt, timezone)
                        : NOT_PLANNED}
                      {showReadiness && d.predictedMaxReadyAt != null && (
                        <div className="text-xs text-muted-foreground">
                          {t('fleets.departures.predictedMaxReady', {
                            time: formatDepotTime(d.predictedMaxReadyAt, timezone),
                          })}
                        </div>
                      )}
                    </TableCell>
                    <TableCell data-testid={`readiness-reason-${d.id}`}>
                      {d.status === 'cancelled'
                        ? cancelReasonLabel(t, d.cancelReason ?? null)
                        : showReadiness && d.readinessReason != null
                          ? t(`fleets.departures.reasons.${d.readinessReason}`)
                          : NOT_PLANNED}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </TabPanel>

      {view != null && view.unidentifiedSessions.length > 0 && (
        <TabPanel
          title={t('sites.fleetReadiness.unidentifiedTitle')}
          description={t('sites.fleetReadiness.unidentifiedDescription')}
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('sites.fleetReadiness.stationEvse')}</TableHead>
                  <TableHead>{t('sites.fleetReadiness.started')}</TableHead>
                  {canAssign && <TableHead className="text-right">{t('common.actions')}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.unidentifiedSessions.map((s) => (
                  <TableRow
                    key={s.sessionId ?? `${s.stationId}-${String(s.evseId)}-${String(s.startedAt)}`}
                    data-testid={`unidentified-row-${s.sessionId ?? s.stationId}`}
                  >
                    <TableCell className="whitespace-nowrap">
                      {s.evseId != null
                        ? t('sites.fleetReadiness.stationWithEvse', {
                            station: s.stationOcppId,
                            evse: s.evseId,
                          })
                        : s.stationOcppId}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {s.startedAt != null
                        ? formatDepotDateTime(s.startedAt, timezone)
                        : NOT_PLANNED}
                    </TableCell>
                    {canAssign && (
                      <TableCell className="text-right">
                        {s.sessionId != null && (
                          <Button
                            type="button"
                            variant="outline"
                            className="gap-1.5"
                            onClick={() => {
                              const { sessionId } = s;
                              if (sessionId != null) setAssignSession({ ...s, sessionId });
                            }}
                          >
                            <Car className="h-4 w-4" aria-hidden="true" />
                            {t('sites.fleetReadiness.assignVehicle')}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabPanel>
      )}

      {planning && (
        <TabPanel
          title={t('sites.fleetReadiness.planTitle')}
          description={
            view.computedAt != null
              ? t('sites.fleetReadiness.planComputedAt', {
                  time: formatDepotDateTime(view.computedAt, timezone),
                  buffer: view.bufferMinutes,
                })
              : t('sites.fleetReadiness.planNotComputed')
          }
        >
          <Suspense fallback={<LoadingState />}>
            <ChargingPlanChart
              input={{
                slotStarts: view.slotStarts ?? [],
                plan: view.plan,
                capacityKw: view.capacityKw,
                pricePerKwh: view.pricePerKwh,
              }}
              labelOf={labelOf}
              timezone={timezone}
              nowMs={nowMs}
            />
          </Suspense>
        </TabPanel>
      )}

      {canAssign && (
        <AssignVehicleDialog
          siteId={siteId}
          session={assignSession}
          depotVehicles={depotVehicles}
          onClose={() => {
            setAssignSession(null);
          }}
        />
      )}
    </>
  );
}
