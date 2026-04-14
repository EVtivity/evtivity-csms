// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router-dom';
import { useTab } from '@/hooks/use-tab';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { MeterValuesTable } from '@/components/MeterValuesTable';
import { SessionDetailsTab } from '@/components/session/SessionDetailsTab';
import { SessionPaymentTab } from '@/components/session/SessionPaymentTab';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { formatCents, formatDuration } from '@/lib/formatting';
import { useUserTimezone } from '@/lib/timezone';
import { sessionStatusVariant } from '@/lib/status-variants';

interface PaymentRecord {
  id: number;
  status: string;
  paymentSource: string;
  currency: string;
  preAuthAmountCents: number | null;
  capturedAmountCents: number | null;
  refundedAmountCents: number;
  failureReason: string | null;
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
  currency: string | null;
  stoppedReason: string | null;
  reservationId: string | null;
  freeVend: boolean | null;
  co2AvoidedKg: number | null;
  paymentRecord: PaymentRecord | null;
}

export function SessionDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const [tab, setTab] = useTab('details');

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
        <p className="text-muted-foreground">{t('common.loading')}</p>
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

  const currency = session.currency ?? 'USD';
  const payment = session.paymentRecord;
  const canRefund =
    payment != null && (payment.status === 'captured' || payment.status === 'partially_refunded');

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
            : session.status}
        </Badge>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="meter-values">{t('sessions.meterValuesTab')}</TabsTrigger>
          <TabsTrigger value="payment">{t('sessions.payment')}</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="space-y-6">
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
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
