// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams } from 'react-router';
import { useTab } from '@/hooks/use-tab';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { EntityNavButtons } from '@/components/entity-nav-buttons';
import { CopyableId } from '@/components/copyable-id';
import { MeterValuesTable } from '@/components/MeterValuesTable';
import { SessionDetailsTab } from '@/components/session/SessionDetailsTab';
import { SessionGuestTab } from '@/components/session/SessionGuestTab';
import { SessionPaymentTab, type PaymentRecord } from '@/components/session/SessionPaymentTab';
import type { NoPaymentReason } from '@/components/session/SessionNoPaymentReason';
import {
  SessionRebillCard,
  type RebillBlockedReason,
  type RebillStatus,
} from '@/components/session/SessionRebillCard';
import { Badge } from '@/components/ui/badge';
import { accountBillingState, isBilledOnAccount } from '@/lib/account-billing';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { formatCents, formatDuration, formatEnergy } from '@/lib/formatting';
import { useUserTimezone } from '@/lib/timezone';
import { sessionStatusVariant } from '@/lib/status-variants';
import { LoadingLogo } from '@/components/loading-logo';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { useHasCompanyWidePermission, useHasPermission } from '@/lib/auth';
import { ExplainButton } from '@/components/ai/ExplainButton';
import { StopButton } from '@/components/stop-button';
import { BillToButton } from '@/components/bill-to-button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { getErrorMessage } from '@/lib/error-message';
import { RecordInsight } from '@/components/ai/insights/RecordInsight';
import { RecordInsightsTab } from '@/components/ai/insights/RecordInsightsTab';

interface GuestSessionInfo {
  sessionToken: string;
  guestEmail: string;
  status: string;
  preAuthAmountCents: number | null;
  provider: string | null;
  providerPaymentId: string | null;
  expiresAt: string;
  createdAt: string;
}

interface SessionDetailData {
  id: string;
  stationId: string;
  stationName: string | null;
  /** OCPP EVSE number of the session, null when unknown. */
  evseId?: number | null;
  /** The station is connected now. */
  stationOnline?: boolean;
  siteName: string | null;
  driverId: string | null;
  driverName: string | null;
  transactionId: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  idleStartedAt: string | null;
  energyDeliveredWh: number | null;
  currentCostCents: number | null;
  finalCostCents: number | null;
  currency: string;
  stoppedReason: string | null;
  reservationId: string | null;
  freeVend: boolean | null;
  billingMode?: 'card' | 'account' | null;
  billingFleetName?: string | null;
  /** Billed on the driver's own member invoice (a fleet that invoices each driver). */
  memberBilled?: boolean;
  invoiceId?: string | null;
  invoiceStatus?: string | null;
  rebillStatus?: RebillStatus | null;
  rebillClaimedAt?: string | null;
  rebillable: boolean;
  rebillBlockedReason: RebillBlockedReason | null;
  co2AvoidedKg: number | null;
  paymentRecord: PaymentRecord | null;
  /** Why there is no payment record, null when there is one. */
  noPaymentReason?: NoPaymentReason | null;
  guestSession: GuestSessionInfo | null;
  token: {
    id: string;
    idToken: string;
    tokenType: string;
    pncContract?: { id: number; pcid: string; status: 'active' | 'revoked' } | null;
  } | null;
  vehicle: {
    id: string;
    make: string | null;
    model: string | null;
    year: string | null;
    licensePlate?: string | null;
    autochargeEnabled?: boolean;
  } | null;
  vehicleCapture?: { value: string; type: string; source: string } | null;
  autocharge?: boolean;
  metadata: Record<string, unknown> | null;
}

export function SessionDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const [tab, setTab] = useTab('details');
  const canReadAudit = useHasPermission('audit:read');
  const canRefundPayments = useHasPermission('payments:write');
  const canStopSession = useHasPermission('stations:write');
  const canEndSession = useHasPermission('sessions:write');
  // Account invoices span every site: moving a session between them needs all-site access.
  const canMoveBilling = useHasCompanyWidePermission('payments:write');
  const [billingConfirmOpen, setBillingConfirmOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const { flags } = useFeatureFlags();
  const showInsightsTab = useHasPermission('aiInsights:read') && flags.aiInsightsEnabled;

  const {
    data: session,
    isLoading,
    isError,
  } = useQuery<SessionDetailData>({
    queryKey: ['sessions', id],
    queryFn: () => api.get<SessionDetailData>(`/v1/sessions/${id ?? ''}`),
    enabled: id != null,
  });

  // Stops the session through the EVSE stop route the station page uses.
  const stopMutation = useMutation({
    mutationFn: (target: { stationId: string; evseId: number }) =>
      api.post<{ sessionId: string; transactionId: string }>(
        `/v1/stations/${target.stationId}/evses/${String(target.evseId)}/stop-active-session`,
        {},
      ),
    onSuccess: () => {
      toast({ variant: 'success', title: t('stations.stopSessionDispatched') });
      void queryClient.invalidateQueries({ queryKey: ['sessions', id] });
    },
    onError: (err: unknown) => {
      toast({
        variant: 'destructive',
        title: getErrorMessage(err, t, 'stations.stopSessionFailed'),
      });
    },
    onSettled: () => {
      setStopConfirmOpen(false);
    },
  });

  // Moves the unbilled account session between the fleet invoice and the member invoice.
  const billingMutation = useMutation({
    mutationFn: (recipient: 'fleet' | 'member') =>
      api.patch<{ moved: boolean }>(`/v1/sessions/${id ?? ''}/billing-recipient`, { recipient }),
    onSuccess: () => {
      toast({ variant: 'success', title: t('billingRecipient.moved') });
      void queryClient.invalidateQueries({ queryKey: ['sessions', id] });
    },
    onError: (err: unknown) => {
      toast({
        variant: 'destructive',
        title: getErrorMessage(err, t, 'billingRecipient.moveFailed'),
      });
    },
    onSettled: () => {
      setBillingConfirmOpen(false);
    },
  });

  // Ends the session in the CSMS, without its offline station.
  const endMutation = useMutation({
    mutationFn: (sessionId: string) =>
      api.post<{ sessionId: string; transactionId: string }>(`/v1/sessions/${sessionId}/end`, {}),
    onSuccess: () => {
      toast({ variant: 'success', title: t('sessions.endSessionRequested') });
      void queryClient.invalidateQueries({ queryKey: ['sessions', id] });
    },
    onError: (err: unknown) => {
      toast({
        variant: 'destructive',
        title: getErrorMessage(err, t, 'sessions.endSessionFailed'),
      });
    },
    onSettled: () => {
      setEndConfirmOpen(false);
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <LoadingLogo size="inline" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <p className="text-destructive">{t('common.loadError')}</p>
      </div>
    );
  }

  if (session == null) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground">{t('sessions.noSessionsFound')}</p>
      </div>
    );
  }

  const currency = session.currency;
  const payment = session.paymentRecord;
  // A capture the provider has not confirmed cannot be refunded yet (409 PAYMENT_OPERATION_PENDING).
  const canRefund =
    canRefundPayments &&
    payment != null &&
    (payment.status === 'captured' || payment.status === 'partially_refunded') &&
    payment.pendingOperation !== 'capture';
  const tokenMismatch =
    session.metadata != null &&
    typeof session.metadata === 'object' &&
    'reservationTokenMismatch' in session.metadata
      ? (session.metadata['reservationTokenMismatch'] as {
          expected: string | null;
          actual: string | null;
        })
      : null;
  // An active session at an online station with a known EVSE can be stopped by
  // a user who controls stations. At an offline station, which cannot take a
  // stop, a user who manages sessions can end it in the CSMS instead.
  const stationOffline = session.stationOnline === false;
  const canStop =
    canStopSession && session.status === 'active' && session.evseId != null && !stationOffline;
  const canEnd = canEndSession && session.status === 'active' && stationOffline;
  const explainContext =
    id == null ? null : { kind: 'session' as const, id, label: session.stationName };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 *:w-full sm:flex-row sm:items-start sm:justify-between sm:*:w-auto">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <BackButton to="/sessions" />
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-bold wrap-anywhere">{t('sessions.title')}</h1>
            <CopyableId id={id ?? ''} />
          </div>
          <Badge
            variant={sessionStatusVariant(
              session.status,
              session.status === 'active' && session.idleStartedAt != null,
            )}
          >
            {session.status === 'active' && session.idleStartedAt != null
              ? t('status.idle')
              : t(`status.${session.status}`, { defaultValue: session.status })}
          </Badge>
          {session.rebillStatus === 'manual' && (
            <Badge variant="warning">{t('sessions.manualBilling')}</Badge>
          )}
          {isBilledOnAccount(session) && (
            <Badge
              variant="info"
              className="max-w-full whitespace-normal"
              data-testid="session-billing-badge"
            >
              {t(session.memberBilled === true ? 'sessions.billedToMember' : 'sessions.billedTo', {
                fleet: session.billingFleetName ?? '',
              })}
              {' · '}
              {t(`sessions.billingState.${accountBillingState(session.invoiceStatus)}`)}
            </Badge>
          )}
          {tokenMismatch != null && (
            <Badge
              variant="warning"
              className="max-w-full whitespace-normal"
              title={t('sessions.reservationTokenMismatchTooltip')}
            >
              {t('sessions.reservationTokenMismatch')}
            </Badge>
          )}
          {(session.status === 'failed' || session.status === 'faulted') &&
            explainContext != null && <ExplainButton context={explainContext} />}
        </div>
        {/* items-start: the buttons line up with the Prev and Next buttons, not their labels. */}
        <div className="flex flex-wrap items-start gap-2" data-testid="session-header-actions">
          {canStop && (
            <StopButton
              label={t('sessions.stopSession')}
              size="header"
              onClick={() => {
                setStopConfirmOpen(true);
              }}
            />
          )}
          {canEnd && (
            <StopButton
              label={t('sessions.endSession')}
              size="header"
              onClick={() => {
                setEndConfirmOpen(true);
              }}
            />
          )}
          {canMoveBilling &&
            isBilledOnAccount(session) &&
            session.invoiceId == null &&
            session.driverId != null && (
              <BillToButton
                recipient={session.memberBilled === true ? 'fleet' : 'member'}
                size="header"
                onClick={() => {
                  setBillingConfirmOpen(true);
                }}
              />
            )}
          <EntityNavButtons resource="sessions" basePath="/sessions" currentId={id} />
        </div>
      </div>

      {canMoveBilling && (
        <ConfirmDialog
          open={billingConfirmOpen}
          onOpenChange={setBillingConfirmOpen}
          title={
            session.memberBilled === true
              ? t('billingRecipient.toFleetTitle')
              : t('billingRecipient.toDriverTitle')
          }
          description={
            session.memberBilled === true
              ? t('billingRecipient.sessionToFleetDescription', {
                  fleet: session.billingFleetName ?? '',
                })
              : t('billingRecipient.sessionToDriverDescription', {
                  driver: session.driverName ?? '',
                })
          }
          confirmLabel={
            session.memberBilled === true
              ? t('billingRecipient.billToFleet')
              : t('billingRecipient.billToDriver')
          }
          isPending={billingMutation.isPending}
          onConfirm={() => {
            billingMutation.mutate(session.memberBilled === true ? 'fleet' : 'member');
          }}
        />
      )}

      {canStop && (
        <ConfirmDialog
          open={stopConfirmOpen}
          onOpenChange={setStopConfirmOpen}
          title={t('sessions.stopSessionConfirmTitle')}
          description={t('sessions.stopSessionConfirmDescription', {
            station: session.stationName ?? '',
            evseId: String(session.evseId),
          })}
          confirmLabel={t('sessions.stopSession')}
          isPending={stopMutation.isPending}
          onConfirm={() => {
            if (session.evseId == null) return;
            stopMutation.mutate({ stationId: session.stationId, evseId: session.evseId });
          }}
        />
      )}

      {canEnd && id != null && (
        <ConfirmDialog
          open={endConfirmOpen}
          onOpenChange={setEndConfirmOpen}
          title={t('sessions.endSessionConfirmTitle')}
          description={
            session.currentCostCents != null
              ? t('sessions.endSessionConfirmDescriptionWithCost', {
                  station: session.stationName ?? '',
                  energy: formatEnergy(session.energyDeliveredWh ?? 0),
                  cost: formatCents(session.currentCostCents, session.currency),
                })
              : t('sessions.endSessionConfirmDescription', {
                  station: session.stationName ?? '',
                  energy: formatEnergy(session.energyDeliveredWh ?? 0),
                })
          }
          confirmLabel={t('sessions.endSession')}
          isPending={endMutation.isPending}
          onConfirm={() => {
            endMutation.mutate(id);
          }}
        />
      )}

      {id != null && showInsightsTab && (
        <RecordInsight
          filter={{ sessionId: id }}
          onOpen={() => {
            setTab('ai-insights');
          }}
        />
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="meter-values">{t('sessions.meterValuesTab')}</TabsTrigger>
          <TabsTrigger value="payment">{t('sessions.payment')}</TabsTrigger>
          {session.guestSession != null && (
            <TabsTrigger value="guest">{t('sessions.guestSessionTab')}</TabsTrigger>
          )}
          {showInsightsTab && (
            <TabsTrigger value="ai-insights">{t('aiInsights.list.title')}</TabsTrigger>
          )}
          {canReadAudit && <TabsTrigger value="history">{t('audit.history')}</TabsTrigger>}
        </TabsList>

        <TabsContent value="details" className="space-y-6">
          <SessionRebillCard session={session} />
          <SessionDetailsTab
            session={session}
            sessionId={id ?? ''}
            currency={currency}
            timezone={timezone}
            formatCents={formatCents}
            formatDuration={formatDuration}
          />
        </TabsContent>

        <TabsContent value="meter-values">
          <MeterValuesTable
            queryKey={['sessions', id ?? '', 'meter-values']}
            url={`/v1/sessions/${id ?? ''}/meter-values`}
            description={t('sessions.meterValuesDescription')}
          />
        </TabsContent>

        <TabsContent value="payment">
          <SessionPaymentTab
            sessionId={id ?? ''}
            payment={payment}
            canRefund={canRefund}
            formatCents={formatCents}
            timezone={timezone}
            noPaymentReason={
              session.noPaymentReason != null
                ? {
                    reason: session.noPaymentReason,
                    fleetName: session.billingFleetName ?? null,
                    memberBilled: session.memberBilled === true,
                    invoiceId: session.invoiceId ?? null,
                    onOpenGuestTab: () => {
                      setTab('guest');
                    },
                  }
                : null
            }
          />
        </TabsContent>

        {session.guestSession != null && (
          <TabsContent value="guest">
            <SessionGuestTab
              guest={session.guestSession}
              currency={currency}
              timezone={timezone}
              formatCents={formatCents}
            />
          </TabsContent>
        )}

        {showInsightsTab && id != null && (
          <TabsContent value="ai-insights">
            <RecordInsightsTab filter={{ sessionId: id }} />
          </TabsContent>
        )}
        <TabsContent value="history">
          <EntityHistoryTab entityType="session" entityId={id ?? ''} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
