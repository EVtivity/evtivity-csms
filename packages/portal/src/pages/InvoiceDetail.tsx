// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/PageHeader';
import { LoadingLogo } from '@/components/loading-logo';
import { api, ApiError } from '@/lib/api';
import { formatCents, formatDay, formatEnergy, formatTaxPercent } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';
import { getErrorMessage } from '@/lib/error-message';
import { billToLines, downloadInvoicePdf, invoiceStatusVariant } from '@/lib/invoices';
import type { PortalInvoiceDetail } from '@/lib/invoices';

function Row({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

/** One of the driver's invoices or credit notes (GET /v1/portal/invoices/:id) with its PDF. */
export function InvoiceDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { id = '' } = useParams<{ id: string }>();
  const timezone = useDriverTimezone();
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['portal-invoice', id],
    queryFn: () => api.get<PortalInvoiceDetail>(`/v1/portal/invoices/${id}`),
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  async function handleDownload(invoice: PortalInvoiceDetail): Promise<void> {
    setDownloading(true);
    try {
      await downloadInvoicePdf(invoice);
    } catch (err) {
      toast({ variant: 'destructive', title: getErrorMessage(err, t, 'invoices.downloadFailed') });
    } finally {
      setDownloading(false);
    }
  }

  if (isLoading) return <LoadingLogo />;

  if (data == null) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="space-y-4">
        <PageHeader title={t('invoices.title')} backTo="/account/invoices" />
        <ErrorCard
          className="mx-auto"
          message={notFound ? t('invoices.notFound') : t('invoices.loadFailed')}
        />
      </div>
    );
  }

  const invoice = data;
  const title = invoice.kind === 'credit_note' ? t('invoices.creditNote') : t('invoices.invoice');
  const billTo = billToLines(invoice.billTo);

  return (
    <div className="space-y-4">
      <PageHeader title={`${title} ${invoice.invoiceNumber}`} backTo="/account/invoices" />

      <Card>
        <CardContent className="space-y-3 p-6">
          <div className="flex items-center justify-between">
            <Badge variant={invoiceStatusVariant(invoice.status)}>
              {t(`invoices.status.${invoice.status}`)}
            </Badge>
            <span className="text-lg font-bold">
              {formatCents(invoice.totalCents, invoice.currency)}
            </span>
          </div>
          {invoice.viaFleetName != null && (
            <p className="text-sm text-muted-foreground">
              {t('invoices.viaFleet', { fleet: invoice.viaFleetName })}
            </p>
          )}
          {invoice.periodStart != null && invoice.periodEnd != null && (
            <Row
              label={t('invoices.period')}
              value={`${formatDay(invoice.periodStart)} - ${formatDay(invoice.periodEnd)}`}
            />
          )}
          {invoice.issuedAt != null && (
            <Row label={t('invoices.issued')} value={formatDay(invoice.issuedAt, timezone)} />
          )}
          {invoice.dueAt != null && invoice.status === 'issued' && (
            <Row label={t('invoices.due')} value={formatDay(invoice.dueAt, timezone)} />
          )}
          {invoice.paidAt != null && (
            <Row label={t('invoices.paidOn')} value={formatDay(invoice.paidAt, timezone)} />
          )}
          {invoice.creditedInvoice != null && (
            <p className="text-sm">
              <Link
                to={`/account/invoices/${invoice.creditedInvoice.id}`}
                className="text-link hover:underline"
              >
                {t('invoices.credits', { number: invoice.creditedInvoice.invoiceNumber })}
              </Link>
            </p>
          )}
          {invoice.creditNote != null && (
            <p className="text-sm">
              <Link
                to={`/account/invoices/${invoice.creditNote.id}`}
                className="text-link hover:underline"
              >
                {t('invoices.creditedBy', { number: invoice.creditNote.invoiceNumber })}
              </Link>
            </p>
          )}
          {invoice.creditReason != null && invoice.creditReason !== '' && (
            <Row label={t('invoices.reason')} value={invoice.creditReason} />
          )}
          <Button
            variant="outline"
            className="w-full"
            disabled={downloading}
            onClick={() => {
              void handleDownload(invoice);
            }}
            data-testid="invoice-download-pdf"
          >
            <Download className="mr-2 h-4 w-4" />
            {t('invoices.downloadPdf')}
          </Button>
        </CardContent>
      </Card>

      {billTo.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('invoices.billTo')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm" data-testid="invoice-bill-to">
            {billTo.map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('invoices.items')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {invoice.lineItems.map((line) => (
            <div
              key={line.id}
              className="flex justify-between gap-4 text-sm"
              data-testid={`invoice-line-${String(line.id)}`}
            >
              <div className="min-w-0">
                <p className="font-medium">{line.description}</p>
                {(line.sessionDate != null ||
                  line.stationName != null ||
                  line.energyWh != null) && (
                  <p className="text-xs text-muted-foreground">
                    {[
                      line.sessionDate != null ? formatDay(line.sessionDate) : null,
                      line.stationName,
                      line.energyWh != null ? formatEnergy(line.energyWh) : null,
                    ]
                      .filter((part) => part != null)
                      .join(' · ')}
                  </p>
                )}
              </div>
              <span className="shrink-0 font-medium">
                {formatCents(line.totalCents, invoice.currency)}
              </span>
            </div>
          ))}
          <div className="space-y-2 border-t border-border pt-3">
            <Row
              label={t('invoices.net')}
              value={formatCents(invoice.subtotalCents, invoice.currency)}
            />
            {invoice.taxBreakdown.map((tax) => (
              <Row
                key={tax.taxRate}
                label={t('sessionDetail.taxAdded', { rate: formatTaxPercent(tax.taxRate) })}
                value={formatCents(tax.taxCents, invoice.currency)}
              />
            ))}
            <Row
              label={t('invoices.total')}
              value={formatCents(invoice.totalCents, invoice.currency)}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
