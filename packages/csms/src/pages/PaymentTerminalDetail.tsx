// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { LoadingLogo } from '@/components/loading-logo';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/content-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EntityNavButtons } from '@/components/entity-nav-buttons';
import { PaymentTerminalDetailsTab } from '@/components/payment-terminals/PaymentTerminalDetailsTab';
import { PaymentTerminalPaymentsTab } from '@/components/payment-terminals/PaymentTerminalPaymentsTab';
import { PaymentTerminalSimTab } from '@/components/payment-terminals/PaymentTerminalSimTab';
import {
  paymentTerminalKey,
  terminalName,
  type PaymentTerminal,
} from '@/components/payment-terminals/payment-terminal-types';
import { useTab } from '@/hooks/use-tab';
import { api, ApiError } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { useUserTimezone } from '@/lib/timezone';

/** One payment terminal: Details, Payments, SIM and History tabs. */
export function PaymentTerminalDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { id = '' } = useParams<{ id: string }>();
  const terminal = useQuery({
    queryKey: paymentTerminalKey(id),
    queryFn: () => api.get<PaymentTerminal>(`/v1/payment-terminals/${id}`),
    enabled: id !== '',
    retry: false,
  });

  if (terminal.isLoading) return <LoadingLogo />;
  if (terminal.data == null) {
    const notFound = terminal.error instanceof ApiError && terminal.error.status === 404;
    return (
      <div className="space-y-6">
        <BackButton to="/payment-terminals" />
        {notFound ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('paymentTerminals.detail.notFound')}
          </p>
        ) : (
          <ErrorState
            onRetry={() => {
              void terminal.refetch();
            }}
          />
        )}
      </div>
    );
  }
  return <PaymentTerminalDetailView terminal={terminal.data} />;
}

function PaymentTerminalDetailView({ terminal }: { terminal: PaymentTerminal }): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const canReadAudit = useHasPermission('audit:read');
  // The payments of a terminal need payments:read too, as their route does.
  const canReadPayments = useHasPermission('payments:read');
  const [activeTab, setActiveTab] = useTab('details');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BackButton to="/payment-terminals" />
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold wrap-anywhere">{terminalName(terminal)}</h1>
          <CopyableId id={terminal.id} />
        </div>
        <Badge variant={terminal.status === 'active' ? 'success' : 'secondary'}>
          {t(`paymentTerminals.status.${terminal.status}`)}
        </Badge>
        <EntityNavButtons
          resource="payment-terminals"
          basePath="/payment-terminals"
          currentId={terminal.id}
        />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          {canReadPayments && (
            <TabsTrigger value="payments">{t('paymentTerminals.detail.tabs.payments')}</TabsTrigger>
          )}
          <TabsTrigger value="sim">{t('paymentTerminals.detail.tabs.sim')}</TabsTrigger>
          {canReadAudit && <TabsTrigger value="history">{t('audit.history')}</TabsTrigger>}
        </TabsList>

        <TabsContent value="details">
          <PaymentTerminalDetailsTab terminal={terminal} timezone={timezone} />
        </TabsContent>

        {canReadPayments && (
          <TabsContent value="payments">
            <PaymentTerminalPaymentsTab terminal={terminal} timezone={timezone} />
          </TabsContent>
        )}

        <TabsContent value="sim">
          <PaymentTerminalSimTab terminal={terminal} />
        </TabsContent>

        {canReadAudit && (
          <TabsContent value="history">
            <EntityHistoryTab entityType="payment_terminal" entityId={terminal.id} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
