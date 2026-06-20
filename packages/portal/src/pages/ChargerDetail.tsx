// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  Info,
  Mail,
  MapPin,
  Phone,
  Plug,
  Star,
  User,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { InfoNote } from '@/components/ui/info-note';
import { ReportIssue } from '@/components/ReportIssue';
import { useToast } from '@/components/ui/toast';
import { PricingDisplay, isPricingFree } from '@/components/PricingDisplay';
import type { PricingInfo } from '@/components/PricingDisplay';
import { EvPlugAnimation } from '@/components/EvPlugAnimation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, formatDate } from '@/lib/utils';
import {
  connectorStatusVariant,
  connectorStatusClassName,
  isEvseSelectable,
} from '@/lib/connector-status';
import { formatConnectorType } from '@/lib/charger-utils';
import { useStationEvents } from '@/hooks/use-station-events';
import { useCableCheck } from '@/hooks/use-cable-check';

interface ConnectorItem {
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: string | null;
  maxCurrentAmps: number | null;
  status: string;
}

interface EvseItem {
  evseId: number;
  connectors: ConnectorItem[];
  reservationExpiresAt: string | null;
  reservationDriverId: string | null;
}

interface MaintenanceInfo {
  active: boolean;
  plannedEndAt: string | null;
  message: string | null;
}

interface StationDetail {
  stationId: string;
  siteId: string | null;
  model: string | null;
  isOnline: boolean;
  isSimulator: boolean;
  siteName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  siteState: string | null;
  siteContactName: string | null;
  siteContactEmail: string | null;
  siteContactPhone: string | null;
  paymentEnabled: boolean;
  evses: EvseItem[];
  maintenance: MaintenanceInfo | null;
}

interface PaymentMethod {
  id: number;
  cardBrand: string | null;
  cardLast4: string | null;
  isDefault: boolean;
}

function formatDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getDefaultStartsAt(): string {
  const d = new Date(Date.now() + 5 * 60 * 1000);
  d.setSeconds(0, 0);
  const remainder = d.getMinutes() % 5;
  if (remainder !== 0) d.setMinutes(d.getMinutes() + (5 - remainder));
  return formatDateTimeLocal(d);
}

function getDefaultExpiresAt(startsAtLocal: string): string {
  const start = new Date(startsAtLocal);
  if (!Number.isFinite(start.getTime())) return '';
  return formatDateTimeLocal(new Date(start.getTime() + 60 * 60 * 1000));
}

interface ChargerDetailProps {
  /**
   * Charge mode (default) presents the Start Charging flow: payment method
   * picker, Stripe pre-auth, RequestStartTransaction. Reserve mode swaps the
   * action for a Reserve Connector flow with start/expire pickers and posts
   * to /v1/portal/reservations. Reused on both routes (`/start/:stationId`
   * and `/reservations/new/:stationId`) so the connector grid, status,
   * favorites, and EV-warning logic stay in one place.
   */
  mode?: 'charge' | 'reserve';
}

export function ChargerDetail({ mode = 'charge' }: ChargerDetailProps = {}): React.JSX.Element {
  const { t } = useTranslation();
  const { stationId } = useParams<{ stationId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isAuthenticated = useAuth((s) => s.isAuthenticated);
  const currentDriverId = useAuth((s) => s.driver?.id ?? null);
  useStationEvents(stationId);

  const evseParam = searchParams.get('evse');
  const [selectedEvseId, setSelectedEvseId] = useState<number | null>(
    evseParam != null ? Number(evseParam) : null,
  );
  const [selectedPm, setSelectedPm] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const { isCheckingStatus, showEvWarning, setShowEvWarning, runWithCableCheck } = useCableCheck();

  // Reserve-mode defaults: startsAt = now + 5 min rounded up to the next
  // 5-minute boundary (always future, even after a few seconds of form-fill);
  // expiresAt = startsAt + 1 hour. Both stored as datetime-local strings so
  // they round-trip through the input control without timezone surprises.
  const [reserveStartsAt, setReserveStartsAt] = useState(getDefaultStartsAt);
  const [reserveExpiresAt, setReserveExpiresAt] = useState(() =>
    getDefaultExpiresAt(getDefaultStartsAt()),
  );
  const [isReserving, setIsReserving] = useState(false);

  const {
    data: station,
    isLoading,
    error: loadError,
  } = useQuery({
    queryKey: ['station-detail', stationId],
    queryFn: () => api.get<StationDetail>(`/v1/portal/chargers/${stationId ?? ''}`),
    enabled: stationId != null,
    // SSE via useStationEvents is the primary update path -- it invalidates
    // this query within ~50ms of any 'station.status' event. Polling at 2s
    // is a defensive fallback for transient SSE drops.
    refetchInterval: 2000,
    // Override the global 30s staleTime so re-mount and focus always refetch
    // the live connector status instead of serving cached state.
    staleTime: 0,
  });

  const { data: pricing } = useQuery({
    queryKey: ['charger-pricing', stationId],
    queryFn: () => api.get<PricingInfo>(`/v1/portal/chargers/${stationId ?? ''}/pricing`),
    enabled: stationId != null && isAuthenticated,
    retry: false,
  });

  // Fetch in reserve mode too: the reservation may incur a no-show holding
  // fee or a cancellation fee, so we always need a card on file regardless
  // of whether the site has paid charging enabled. Charge mode continues to
  // gate on paymentEnabled to avoid an unnecessary fetch on free sites.
  const { data: paymentMethods } = useQuery({
    queryKey: ['portal-payment-methods'],
    queryFn: () => api.get<PaymentMethod[]>('/v1/portal/payment-methods'),
    enabled: mode === 'reserve' || station?.paymentEnabled === true,
  });
  const hasDefaultPaymentMethod =
    paymentMethods != null && paymentMethods.some((pm) => pm.isDefault);

  // Reservation policy (max hours) for the reserve-mode hint. Public endpoint.
  const reservationPolicyQuery = useQuery({
    queryKey: ['portal-features'],
    queryFn: () => api.get<{ reservationMaxHours: number }>('/v1/portal/features'),
    enabled: mode === 'reserve',
    staleTime: 5 * 60_000,
  });
  const reservationMaxHours = reservationPolicyQuery.data?.reservationMaxHours ?? 0;

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: favoriteData } = useQuery({
    queryKey: ['favorite-check', stationId],
    queryFn: () =>
      api.get<{ isFavorite: boolean; favoriteId: number | null }>(
        `/v1/portal/favorites/check/${stationId ?? ''}`,
      ),
    enabled: stationId != null && isAuthenticated,
  });

  const { data: activeSessions } = useQuery({
    queryKey: ['portal-active-sessions'],
    queryFn: () =>
      api.get<{ data: { id: string; stationId: string }[] }>('/v1/portal/chargers/sessions/active'),
    enabled: isAuthenticated,
  });

  const hasActiveSession =
    activeSessions != null &&
    activeSessions.data.length > 0 &&
    activeSessions.data.every((s) => s.stationId !== stationId);

  const addFavoriteMutation = useMutation({
    mutationFn: () => api.post('/v1/portal/favorites', { stationId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['favorite-check', stationId] });
      void queryClient.invalidateQueries({ queryKey: ['portal-favorites'] });
      toast({ variant: 'success', title: t('favorites.added') });
    },
  });

  const removeFavoriteMutation = useMutation({
    mutationFn: (favoriteId: number) => api.delete(`/v1/portal/favorites/${String(favoriteId)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['favorite-check', stationId] });
      void queryClient.invalidateQueries({ queryKey: ['portal-favorites'] });
      toast({ variant: 'success', title: t('favorites.removed') });
    },
  });

  const [showRemoveFavorite, setShowRemoveFavorite] = useState(false);

  // Auto-select default payment method
  if (selectedPm == null && paymentMethods != null) {
    const defaultPm = paymentMethods.find((pm) => pm.isDefault);
    if (defaultPm != null) {
      setSelectedPm(defaultPm.id);
    } else if (paymentMethods.length > 0 && paymentMethods[0] != null) {
      setSelectedPm(paymentMethods[0].id);
    }
  }

  const isFree = pricing != null && isPricingFree(pricing);

  async function doStart(): Promise<void> {
    if (selectedEvseId == null) return;
    setIsStarting(true);
    setError('');
    try {
      const result = await api.post<{ chargingSessionId: string }>(
        `/v1/portal/chargers/${stationId ?? ''}/evse/${String(selectedEvseId)}/start`,
        selectedPm != null ? { paymentMethodId: selectedPm } : {},
      );
      void navigate(`/sessions/${result.chargingSessionId}`, {
        replace: true,
        state: { fromCharge: true },
      });
    } catch (err: unknown) {
      if (err != null && typeof err === 'object' && 'body' in err) {
        const body = (err as { body: { error?: string } }).body;
        setError(body.error ?? t('stationDetail.failedToStart'));
      } else {
        setError(t('stationDetail.failedToStart'));
      }
    } finally {
      setIsStarting(false);
    }
  }

  // Reserve-mode submit. Posts to the same /v1/portal/reservations endpoint
  // the old inline form used; on success navigates back to the reservations
  // list, which re-fetches via query invalidation in Reservations.tsx (the
  // user lands on the new entry without an extra step).
  async function handleReserve(): Promise<void> {
    if (stationId == null || reserveStartsAt === '' || reserveExpiresAt === '') return;
    setError('');
    // datetime-local strings without TZ parse as local time. Browsers vary on
    // whether an unparsable value yields NaN or throws on toISOString -- guard
    // explicitly so we never POST a malformed body.
    const expiresDate = new Date(reserveExpiresAt);
    if (!Number.isFinite(expiresDate.getTime())) {
      setError(t('reservations.createFailed'));
      return;
    }
    let startsIso: string | undefined;
    if (reserveStartsAt !== '') {
      const startsDate = new Date(reserveStartsAt);
      if (!Number.isFinite(startsDate.getTime())) {
        setError(t('reservations.createFailed'));
        return;
      }
      startsIso = startsDate.toISOString();
    }
    setIsReserving(true);
    try {
      const body: {
        stationId: string;
        evseId?: number;
        startsAt?: string;
        expiresAt: string;
      } = {
        stationId,
        expiresAt: expiresDate.toISOString(),
      };
      if (selectedEvseId != null) body.evseId = selectedEvseId;
      if (startsIso != null) body.startsAt = startsIso;
      await api.post('/v1/portal/reservations', body);
      // Mark the list cache stale so Reservations.tsx refetches on mount.
      // Without this, navigating back to the list shows the cached page
      // (without the new entry) until the user manually refreshes.
      await queryClient.invalidateQueries({ queryKey: ['portal-reservations'] });
      void navigate('/reservations');
    } catch (err: unknown) {
      if (err != null && typeof err === 'object' && 'body' in err) {
        const body = (err as { body: { error?: string } }).body;
        setError(body.error ?? t('reservations.createFailed'));
      } else {
        setError(t('reservations.createFailed'));
      }
    } finally {
      setIsReserving(false);
    }
  }

  async function handleStart(): Promise<void> {
    if (selectedEvseId == null) return;
    await runWithCableCheck(
      () =>
        api.post<{ connectorStatus: string | null; error?: string }>(
          `/v1/portal/chargers/${stationId ?? ''}/evse/${String(selectedEvseId)}/check-status`,
          {},
        ),
      () => doStart(),
      setError,
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-muted-foreground">{t('charger.loadingInfo')}</p>
      </div>
    );
  }

  if (loadError != null || station == null) {
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          className="gap-1 px-0"
          onClick={() => {
            void navigate(-1);
          }}
        >
          <ArrowLeft className="h-4 w-4" />
          {t('common.back')}
        </Button>
        <p className="text-destructive">{t('charger.notFound')}</p>
      </div>
    );
  }

  // Auto-select the connector when exactly one is selectable, so a single-
  // connector station is ready to start or reserve without a tap. Runs only
  // while nothing is selected, so it never overrides a manual pick or the
  // QR-scanned evse param.
  if (selectedEvseId == null) {
    const selectable = station.evses.filter((evse) =>
      isEvseSelectable(evse, {
        mode,
        isOnline: station.isOnline,
        maintenanceActive: station.maintenance?.active === true,
        currentDriverId,
      }),
    );
    if (selectable.length === 1 && selectable[0] != null) {
      setSelectedEvseId(selectable[0].evseId);
    }
  }

  // Charge-mode payment + start gating only -- reserve mode never needs
  // payment-method selection or active-session checks.
  const showPaymentSection =
    mode === 'charge' &&
    selectedEvseId != null &&
    station.paymentEnabled &&
    !isFree &&
    isAuthenticated &&
    !hasActiveSession;
  const showStartButton =
    mode === 'charge' &&
    selectedEvseId != null &&
    (isFree || !station.paymentEnabled || selectedPm != null) &&
    !hasActiveSession;
  // Reserve mode shows the time pickers + Reserve button as soon as the
  // user lands on the page so they can pick a connector OR leave it null.
  // Reserve allows null evseId (station-level "any connector" reservation).
  const showReserveSection = mode === 'reserve' && station.isOnline;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          className="gap-1 px-0"
          onClick={() => {
            void navigate(-1);
          }}
        >
          <ArrowLeft className="h-4 w-4" />
          {t('common.back')}
        </Button>
      </div>

      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-xl font-bold">{station.stationId}</h1>
            {favoriteData?.isFavorite === true && (
              <Star className="h-4 w-4 shrink-0 text-warning" fill="currentColor" />
            )}
          </div>
          {station.siteName != null && (
            <p className="text-xs text-muted-foreground">{station.siteName}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              station.isOnline ? 'bg-success' : 'bg-destructive',
            )}
          />
          <span className="text-xs font-medium">
            {station.isOnline ? t('charger.online') : t('charger.offline')}
          </span>
        </div>
      </div>

      {/* Location */}
      {station.siteAddress != null && station.siteId != null ? (
        <Link
          to={`/location/${station.siteId}?from=${encodeURIComponent(`/start/${station.stationId}`)}`}
          className="flex items-start gap-2 text-sm text-primary hover:underline transition-colors"
        >
          <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            {station.siteAddress}
            {station.siteCity != null && `, ${station.siteCity}`}
            {station.siteState != null && `, ${station.siteState}`}
          </span>
        </Link>
      ) : station.siteAddress != null ? (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            {station.siteAddress}
            {station.siteCity != null && `, ${station.siteCity}`}
            {station.siteState != null && `, ${station.siteState}`}
          </span>
        </div>
      ) : null}

      {station.maintenance?.active === true && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-4">
          <p className="font-semibold">{t('charger.maintenanceTitle')}</p>
          {station.maintenance.plannedEndAt != null && (
            <p className="mt-1 text-sm">
              {t('charger.maintenanceUntil', {
                time: new Date(station.maintenance.plannedEndAt).toLocaleString(),
              })}
            </p>
          )}
          {station.maintenance.message != null && station.maintenance.message.length > 0 && (
            <p className="mt-2 text-sm">{station.maintenance.message}</p>
          )}
        </div>
      )}

      {/* Site Contact */}
      {(station.siteContactName != null ||
        station.siteContactEmail != null ||
        station.siteContactPhone != null) && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm">{t('charger.siteContact')}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-1.5">
            {station.siteContactName != null && (
              <div className="flex items-center gap-2 text-sm">
                <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span>{station.siteContactName}</span>
              </div>
            )}
            {station.siteContactEmail != null && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <a
                  href={`mailto:${station.siteContactEmail}`}
                  className="text-primary hover:underline"
                >
                  {station.siteContactEmail}
                </a>
              </div>
            )}
            {station.siteContactPhone != null && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <a
                  href={`tel:${station.siteContactPhone}`}
                  className="text-primary hover:underline"
                >
                  {station.siteContactPhone}
                </a>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Pricing */}
      {pricing != null && <PricingDisplay pricing={pricing} />}

      {/* EVSE selection instruction */}
      {station.evses.length > 0 && !hasActiveSession && (
        <p className="text-sm text-muted-foreground">{t('stationDetail.selectConnector')}</p>
      )}

      {/* Active session overlay */}
      {hasActiveSession && (
        <div className="rounded-lg border bg-card p-6 flex flex-col items-center gap-3 text-center">
          <AlertCircle className="h-8 w-8 text-warning" />
          <p className="text-sm font-medium">{t('stationDetail.activeSessionWarning')}</p>
        </div>
      )}

      {/* EVSE grid — one tile per EVSE */}
      {station.evses.length > 0 && !hasActiveSession && (
        <div className={`grid gap-3 ${station.evses.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {station.evses.map((evse) => {
            const connectorStatus = evse.connectors[0]?.status ?? 'unavailable';
            const isAvailable = isEvseSelectable(evse, {
              mode,
              isOnline: station.isOnline,
              maintenanceActive: station.maintenance?.active === true,
              currentDriverId,
            });
            const isSelected = selectedEvseId === evse.evseId;

            const connectorTypes = [
              ...new Set(evse.connectors.map((c) => c.connectorType).filter((t) => t != null)),
            ].map(formatConnectorType);
            const maxPowerKw = evse.connectors.reduce((max, c) => {
              const kw = c.maxPowerKw != null ? Number(c.maxPowerKw) : 0;
              return kw > max ? kw : max;
            }, 0);
            const maxCurrentAmps = evse.connectors.reduce((max, c) => {
              const amps = c.maxCurrentAmps ?? 0;
              return amps > max ? amps : max;
            }, 0);

            const isCharging = ['charging', 'discharging'].includes(connectorStatus);
            const isIdleState = ['suspended_ev', 'suspended_evse', 'idle'].includes(
              connectorStatus,
            );
            return (
              <Card
                key={evse.evseId}
                className={cn(
                  'transition-all',
                  isAvailable
                    ? isSelected
                      ? 'border-primary bg-primary/5 shadow-md cursor-pointer'
                      : 'hover:shadow-md cursor-pointer'
                    : 'opacity-50 cursor-not-allowed',
                  isCharging && 'ring-2 ring-success animate-pulse',
                  isIdleState && 'ring-2 ring-warning animate-pulse',
                )}
                onClick={() => {
                  if (isAvailable) {
                    setSelectedEvseId(isSelected ? null : evse.evseId);
                    setError('');
                  }
                }}
              >
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <Badge
                      variant={connectorStatusVariant()}
                      className={cn('text-xs', connectorStatusClassName(connectorStatus))}
                    >
                      {t(`status.${connectorStatus}`)}
                    </Badge>
                    {isSelected && <Zap className="h-4 w-4 text-primary" />}
                  </div>
                  {connectorStatus === 'reserved' && (
                    <p className="text-xs text-muted-foreground">
                      {evse.reservationExpiresAt != null
                        ? t('charger.reservedUntil', {
                            time: formatDate(evse.reservationExpiresAt),
                          })
                        : t('charger.reserved')}
                    </p>
                  )}
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1 text-sm font-medium">
                      <Plug className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>{connectorTypes.length > 0 ? connectorTypes.join(', ') : 'n/a'}</span>
                    </div>
                    {(maxPowerKw > 0 || maxCurrentAmps > 0) && (
                      <p className="text-xs text-muted-foreground">
                        {maxPowerKw > 0 ? `${String(maxPowerKw)} kW` : ''}
                        {maxPowerKw > 0 && maxCurrentAmps > 0 ? ' / ' : ''}
                        {maxCurrentAmps > 0 ? `${String(maxCurrentAmps)}A` : ''}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t('stationDetail.connectorPort', { id: evse.evseId })}
                    </p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Reservation time pickers + Reserve button (reserve mode) */}
      {showReserveSection && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">{t('reservations.reserveConnector')}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            <div>
              <label className="text-sm font-medium" htmlFor="reserveStartsAt">
                {t('reservations.startsAt')}
              </label>
              <Input
                id="reserveStartsAt"
                type="datetime-local"
                value={reserveStartsAt}
                onChange={(e) => {
                  const next = e.target.value;
                  setReserveStartsAt(next);
                  // Auto-suggest expires = starts + 1h, but ONLY when the
                  // expires field is still empty. We don't try to detect and
                  // overwrite a previous auto-suggested value -- if the user
                  // already has a value there, we leave it alone.
                  if (next !== '' && reserveExpiresAt === '') {
                    const start = new Date(next);
                    if (!Number.isNaN(start.getTime())) {
                      const oneHourLater = new Date(start.getTime() + 60 * 60 * 1000);
                      // datetime-local format: YYYY-MM-DDTHH:mm
                      const pad = (n: number) => String(n).padStart(2, '0');
                      const formatted = `${String(oneHourLater.getFullYear())}-${pad(oneHourLater.getMonth() + 1)}-${pad(oneHourLater.getDate())}T${pad(oneHourLater.getHours())}:${pad(oneHourLater.getMinutes())}`;
                      setReserveExpiresAt(formatted);
                    }
                  }
                }}
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="reserveExpiresAt">
                {t('reservations.expiresAt')}
              </label>
              <Input
                id="reserveExpiresAt"
                type="datetime-local"
                value={reserveExpiresAt}
                onChange={(e) => {
                  setReserveExpiresAt(e.target.value);
                }}
              />
            </div>
            <InfoNote>
              {reservationMaxHours > 0
                ? `${t('reservations.maxHoursHint', { hours: reservationMaxHours })} ${t('reservations.noShowFeeNote')}`
                : t('reservations.noShowFeeNote')}
            </InfoNote>
            {!hasDefaultPaymentMethod && paymentMethods != null && (
              <Alert variant="warning">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {t('reservations.paymentMethodRequired')}{' '}
                  <Link to="/payment-methods" className="underline font-medium">
                    {t('payments.addPaymentMethod')}
                  </Link>
                </AlertDescription>
              </Alert>
            )}
            {error !== '' && <p className="text-sm text-destructive">{error}</p>}
            <Button
              className="w-full gap-2"
              size="lg"
              disabled={
                isReserving ||
                reserveStartsAt === '' ||
                reserveExpiresAt === '' ||
                !hasDefaultPaymentMethod
              }
              onClick={() => void handleReserve()}
            >
              <CalendarClock className="h-5 w-5" />
              {isReserving ? t('reservations.creating') : t('reservations.reserveConnector')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Payment method selection */}
      {showPaymentSection && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">{t('stationDetail.paymentMethod')}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-2">
            {paymentMethods == null || paymentMethods.length === 0 ? (
              <div>
                <p className="text-sm text-muted-foreground mb-2">
                  {t('stationDetail.addPaymentPrompt')}
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    void navigate('/payment-methods');
                  }}
                >
                  {t('stationDetail.addPaymentMethod')}
                </Button>
              </div>
            ) : (
              paymentMethods.map((pm) => (
                <div
                  key={pm.id}
                  className={`flex items-center gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                    selectedPm === pm.id ? 'border-primary bg-primary/5' : 'hover:bg-accent/50'
                  }`}
                  onClick={() => {
                    setSelectedPm(pm.id);
                  }}
                >
                  <Zap className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">
                    {t('payments.cardEnding', {
                      brand: pm.cardBrand ?? 'Card',
                      last4: pm.cardLast4 ?? '****',
                    })}
                  </span>
                  {pm.isDefault && <Badge variant="secondary">{t('common.default')}</Badge>}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* Start button */}
      {showStartButton && (
        <div className="space-y-2">
          {error !== '' && <p className="text-sm text-destructive">{error}</p>}
          <Button
            className="w-full gap-2"
            size="lg"
            disabled={isStarting || isCheckingStatus}
            onClick={() => void handleStart()}
          >
            <Zap className="h-5 w-5" />
            {isCheckingStatus
              ? t('charger.checkingStatus')
              : isStarting
                ? t('stationDetail.starting')
                : t('stationDetail.startCharging')}
          </Button>
        </div>
      )}

      {/* Favorites */}
      {isAuthenticated &&
        (favoriteData?.isFavorite === true ? (
          <Button
            variant="outline"
            className="w-full"
            disabled={removeFavoriteMutation.isPending}
            onClick={() => {
              setShowRemoveFavorite(true);
            }}
          >
            {t('favorites.removeFromFavorites')}
          </Button>
        ) : (
          <Button
            variant="outline"
            className="w-full"
            disabled={addFavoriteMutation.isPending}
            onClick={() => {
              addFavoriteMutation.mutate();
            }}
          >
            {t('favorites.addToFavorites')}
          </Button>
        ))}

      {/* Report Issue */}
      <ReportIssue stationId={station.stationId} stationName={station.stationId} />

      {/* EV not detected warning -- informational only. Cable must be in
          before charging can start; the simulator hard-rejects RemoteStart
          on no-cable, so a bypass button would just create a stuck session. */}
      <ConfirmDialog
        open={showEvWarning}
        onOpenChange={setShowEvWarning}
        title={t('charger.evNotDetectedTitle')}
        description={t('charger.evNotDetectedDescription')}
        confirmLabel={t('common.ok')}
        hideCancel
        onConfirm={() => undefined}
      >
        <EvPlugAnimation />
        {station.isSimulator && (
          <Alert variant="info" className="mt-4">
            <Info className="h-4 w-4" />
            <AlertDescription>{t('charger.simulatorPlugInHint')}</AlertDescription>
          </Alert>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={showRemoveFavorite}
        onOpenChange={setShowRemoveFavorite}
        title={t('favorites.confirmRemoveTitle')}
        description={t('favorites.confirmRemoveDescription')}
        confirmLabel={t('favorites.removeFromFavorites')}
        variant="destructive"
        onConfirm={() => {
          if (favoriteData?.favoriteId != null) {
            removeFavoriteMutation.mutate(favoriteData.favoriteId);
          }
        }}
      />
    </div>
  );
}
