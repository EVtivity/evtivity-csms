// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardList,
  CardListLink,
  CardTitle,
} from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { ChartBody, type QueryState } from '@/components/charts/ChartBody';
import { formatCents } from '@/lib/formatting';
import { formatDate, useUserTimezone } from '@/lib/timezone';
import type { FleetSummaryInvoice } from '@/hooks/use-fleet-dashboard';

interface FleetInvoicesWidgetProps {
  invoices: FleetSummaryInvoice[];
  actions?: React.ReactNode;
  state?: QueryState;
}

/** The latest fleet invoices and credit notes of the fleets the Dashboard shows. */
export function FleetInvoicesWidget({
  invoices,
  actions,
  state,
}: FleetInvoicesWidgetProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base flex items-center gap-1.5">
          {t('dashboard.fleet.invoicesChart')}
          <InfoTooltip
            content={<div className="max-w-56">{t('dashboard.fleet.invoicesInfo')}</div>}
          />
        </CardTitle>
        {actions}
      </CardHeader>
      <CardContent variant={invoices.length > 0 ? 'list' : 'default'}>
        <ChartBody
          state={state}
          isEmpty={invoices.length === 0}
          emptyText={t('dashboard.fleet.noInvoices')}
        >
          <CardList>
            {invoices.map((invoice) => (
              <CardListLink key={invoice.id} to={`/invoices/${invoice.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{invoice.invoiceNumber}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {invoice.fleetName}
                    {invoice.issuedAt != null && ` · ${formatDate(invoice.issuedAt, timezone)}`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-sm tabular-nums">
                    {formatCents(invoice.totalCents, invoice.currency)}
                  </span>
                  <Badge variant={invoice.kind === 'credit_note' ? 'info' : 'secondary'}>
                    {invoice.kind === 'credit_note'
                      ? t('dashboard.fleet.creditNote')
                      : t(`invoices.status.${invoice.status}`, invoice.status)}
                  </Badge>
                </div>
              </CardListLink>
            ))}
          </CardList>
        </ChartBody>
      </CardContent>
    </Card>
  );
}
