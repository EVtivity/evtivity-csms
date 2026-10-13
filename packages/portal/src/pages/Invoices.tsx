// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/PageHeader';
import { LoadingLogo } from '@/components/loading-logo';
import { api } from '@/lib/api';
import { formatCents, formatDay } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';
import { invoiceStatusVariant } from '@/lib/invoices';
import type { PortalInvoice } from '@/lib/invoices';

const PAGE_SIZE = 20;

/** The driver's invoices and credit notes (GET /v1/portal/invoices), newest first. */
export function Invoices(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useDriverTimezone();
  const [page, setPage] = useState(1);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['portal-invoices', page],
    queryFn: () =>
      api.get<{ data: PortalInvoice[]; total: number }>(
        `/v1/portal/invoices?page=${String(page)}&limit=${String(PAGE_SIZE)}`,
      ),
    staleTime: 60_000,
  });

  const invoices = data?.data ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <PageHeader title={t('invoices.title')} backTo="/account" />

      {isLoading && <LoadingLogo size="inline" />}

      {isError && (
        <p className="text-center text-sm text-destructive">{t('invoices.loadFailed')}</p>
      )}

      {!isLoading && !isError && invoices.length === 0 && (
        <p className="text-center text-sm text-muted-foreground">{t('invoices.empty')}</p>
      )}

      {invoices.map((invoice) => (
        <Card
          key={invoice.id}
          className="cursor-pointer"
          data-testid={`invoice-row-${invoice.id}`}
          onClick={() => {
            void navigate(`/account/invoices/${invoice.id}`);
          }}
        >
          <CardContent className="space-y-2 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {invoice.kind === 'credit_note' ? t('invoices.creditNote') : t('invoices.invoice')}{' '}
                {invoice.invoiceNumber}
              </span>
              <Badge variant={invoiceStatusVariant(invoice.status)}>
                {t(`invoices.status.${invoice.status}`)}
              </Badge>
            </div>
            {invoice.viaFleetName != null && (
              <p className="text-xs text-muted-foreground">
                {t('invoices.viaFleet', { fleet: invoice.viaFleetName })}
              </p>
            )}
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{formatDay(invoice.issuedAt ?? invoice.createdAt, timezone)}</span>
              <span className="text-sm font-medium text-foreground">
                {formatCents(invoice.totalCents, invoice.currency)}
              </span>
            </div>
          </CardContent>
        </Card>
      ))}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              setPage((p) => p - 1);
            }}
          >
            {t('common.previous')}
          </Button>
          <span className="flex items-center text-sm text-muted-foreground">
            {t('sessions.pageOf', { page, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => {
              setPage((p) => p + 1);
            }}
          >
            {t('common.next')}
          </Button>
        </div>
      )}
    </div>
  );
}
