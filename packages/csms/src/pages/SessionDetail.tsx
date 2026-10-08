// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router';
import { useTab } from '@/hooks/use-tab';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { EntityNavButtons } from '@/components/entity-nav-buttons';
import { CopyableId } from '@/components/copyable-id';
import { MeterValuesTable } from '@/components/MeterValuesTable';
import { SessionDetailsTab } from '@/components/session/SessionDetailsTab';
import { SessionGuestTab } from '@/components/session/SessionGuestTab';
import { SessionPaymentTab, type PaymentRecord } from '@/components/session/SessionPaymentTab';
import {
  SessionRebillCard,
  type RebillBlockedReason,
  type RebillStatus,
} from '@/components/session/SessionRebillCard';
import { Badge } from '@/components/ui/badge';
import { accountBillingState, isBilledOnAccount } from '@/lib/account-billing';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { formatCents, formatDuration } from '@/lib/formatting';
import { useUserTimezone } from '@/lib/timezone';
import { sessionStatusVariant } from '@/lib/status-variants';
import { LoadingLogo } from '@/components/loading-logo';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { useHasPermission } from '@/lib/auth';

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
  invoiceStatus?: string | null;
  rebillStatus?: RebillStatus | null;
  rebillClaimedAt?: string | null;
  rebillable: boolean;
  rebillBlockedReason: RebillBlockedReason | null;
  co2AvoidedKg: number | null;
  paymentRecord: PaymentRecord | null;
  guestSession: GuestSessionInfo | null;
  token: { id: string; idToken: string; tokenType: string } | null;
  vehicle: {
    id: string;
    make: string | null;
    model: string | null;
    year: string | null;
  } | null;
  metadata: Record<string, unknown> | null;
}

export function SessionDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const [tab, setTab] = useTab('details');
  const canReadAudit = useHasPermission('audit:read');

  const {
    data: session,
    isLoading,
    isError,
  } = useQuery<SessionDetailData>({
    queryKey: ['sessions', id],
    queryFn: () => api.get<SessionDetailData>(`/v1/sessions/${id ?? ''}`),
    enabled: id != null,
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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/sessions" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{t('sessions.title')}</h1>
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
          <Badge variant="info" data-testid="session-billing-badge">
            {t('sessions.billedTo', { fleet: session.billingFleetName ?? '' })}
            {' · '}
            {t(`sessions.billingState.${accountBillingState(session.invoiceStatus)}`)}
          </Badge>
        )}
        {tokenMismatch != null && (
          <Badge variant="warning" title={t('sessions.reservationTokenMismatchTooltip')}>
            {t('sessions.reservationTokenMismatch')}
          </Badge>
        )}
        <EntityNavButtons resource="sessions" basePath="/sessions" currentId={id} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="meter-values">{t('sessions.meterValuesTab')}</TabsTrigger>
          <TabsTrigger value="payment">{t('sessions.payment')}</TabsTrigger>
          {session.guestSession != null && (
            <TabsTrigger value="guest">{t('sessions.guestSessionTab')}</TabsTrigger>
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
            queryKey="session-meter-values"
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

        <TabsContent value="history">
          <EntityHistoryTab entityType="session" entityId={id ?? ''} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
