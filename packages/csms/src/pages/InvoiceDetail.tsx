// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, Mail, Printer } from 'lucide-react';
import { BackButton } from '@/components/back-button';
import { EntityNavButtons } from '@/components/entity-nav-buttons';
import { API_BASE_URL } from '@/lib/config';
import { DriverInvoice, INVOICE_STATUS_VARIANT } from '@/components/driver/DriverInvoicesTab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { ApiError } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatCents } from '@/lib/formatting';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { LoadingLogo } from '@/components/loading-logo';

interface InvoiceRecord extends DriverInvoice {
  metadata: Record<string, unknown> | null;
  updatedAt: string;
}

interface InvoiceLineItem {
  id: number;
  invoiceId: string;
  sessionId: string | null;
  description: string;
  quantity: string;
  unitPriceCents: number;
  totalCents: number;
  taxCents: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface InvoiceDriver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
}

interface InvoiceDetailData {
  invoice: InvoiceRecord;
  lineItems: InvoiceLineItem[];
  driver: InvoiceDriver | null;
}

function downloadInvoicePdf(invoice: { id: string; invoiceNumber: string }): Promise<void> {
  return fetch(`${API_BASE_URL}/v1/invoices/${invoice.id}/pdf`, { credentials: 'include' })
    .then((res) => {
      if (!res.ok) throw new Error(`Download failed (${String(res.status)})`);
      return res.blob();
    })
    .then((blob) => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${invoice.invoiceNumber}.pdf`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
}

export function InvoiceDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('payments:write');
  const [voidOpen, setVoidOpen] = useState(false);
  const [resendOpen, setResendOpen] = useState(false);

  const { data, isLoading, isError, error } = useQuery<InvoiceDetailData>({
    queryKey: ['invoices', id],
    queryFn: () => api.get<InvoiceDetailData>(`/v1/invoices/${id ?? ''}`),
    enabled: id != null,
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/settings'),
  });
  const companyName =
    settings != null &&
    typeof settings['company.name'] === 'string' &&
    settings['company.name'] !== ''
      ? settings['company.name']
      : 'EVtivity';
  const companyLogo =
    settings != null &&
    typeof settings['company.logo'] === 'string' &&
    settings['company.logo'] !== ''
      ? settings['company.logo']
      : null;

  const voidMutation = useMutation({
    mutationFn: () => api.patch(`/v1/invoices/${id ?? ''}/void`, {}),
    onSuccess: () => {
      toast({ variant: 'success', title: t('invoices.voidSuccess') });
      setVoidOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['invoices', id] });
      if (data?.invoice.driverId != null) {
        void queryClient.invalidateQueries({
          queryKey: ['drivers', data.invoice.driverId, 'invoices'],
        });
      }
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  const resendMutation = useMutation({
    mutationFn: () => api.post(`/v1/invoices/${id ?? ''}/send`, {}),
    onSuccess: () => {
      toast({ variant: 'success', title: t('invoices.resendSuccess') });
      setResendOpen(false);
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <LoadingLogo size="inline" />
      </div>
    );
  }

  if (isError || data == null) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="space-y-6">
        <BackButton to="/drivers" />
        {notFound ? (
          <p className="text-muted-foreground">{t('invoices.notFound')}</p>
        ) : (
          <p className="text-destructive">{t('common.loadError')}</p>
        )}
      </div>
    );
  }

  const { invoice, lineItems } = data;

  function handleDownload(): void {
    void downloadInvoicePdf(invoice).catch((err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <BackButton
            to={invoice.driverId != null ? `/drivers/${invoice.driverId}?tab=invoices` : '/drivers'}
          />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">{invoice.invoiceNumber}</h1>
          </div>
          <Badge variant={INVOICE_STATUS_VARIANT[invoice.status]}>
            {t(
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
              `invoices.status.${invoice.status}` as never,
            )}
          </Badge>
        </div>
        <div className="print-hidden flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              window.print();
            }}
          >
            <Printer className="mr-2 h-4 w-4" />
            {t('invoices.print')}
          </Button>
          <Button variant="outline" onClick={handleDownload}>
            <Download className="mr-2 h-4 w-4" />
            {t('invoices.download')}
          </Button>
          {canWrite && invoice.driverId != null && (
            <Button
              variant="outline"
              onClick={() => {
                setResendOpen(true);
              }}
            >
              <Mail className="mr-2 h-4 w-4" />
              {t('invoices.resend')}
            </Button>
          )}
          {canWrite && invoice.status !== 'void' && (
            <Button
              variant="destructive"
              onClick={() => {
                setVoidOpen(true);
              }}
            >
              {t('invoices.voidInvoice')}
            </Button>
          )}
          <EntityNavButtons resource="invoices" basePath="/invoices" currentId={id} />
        </div>
      </div>

      <ConfirmDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        title={t('invoices.voidInvoice')}
        description={t('invoices.confirmVoid')}
        confirmLabel={t('invoices.void')}
        isPending={voidMutation.isPending}
        onConfirm={() => {
          voidMutation.mutate();
          return false;
        }}
      />

      <ConfirmDialog
        open={resendOpen}
        onOpenChange={setResendOpen}
        variant="default"
        title={t('invoices.resendInvoice')}
        description={t('invoices.confirmResend')}
        confirmLabel={t('invoices.resend')}
        isPending={resendMutation.isPending}
        onConfirm={() => {
          resendMutation.mutate();
          return false;
        }}
      />

      <div className="invoice-print-area space-y-6">
        <div className="flex items-center gap-4">
          <img
            src={companyLogo ?? '/evtivity-logo-animated.svg'}
            alt={companyName}
            className="h-12 w-auto max-w-[200px] object-contain"
          />
          <span className="text-xl font-semibold">{companyName}</span>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{invoice.invoiceNumber}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">{t('invoices.billedTo')}</dt>
                <dd className="text-sm font-medium">
                  {invoice.driverId != null ? (
                    <Link
                      to={`/drivers/${invoice.driverId}`}
                      className="text-primary hover:underline"
                    >
                      {data.driver != null
                        ? `${data.driver.firstName} ${data.driver.lastName}`.trim()
                        : invoice.driverId}
                    </Link>
                  ) : (
                    '--'
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">{t('invoices.issuedAt')}</dt>
                <dd className="text-sm font-medium">
                  {invoice.issuedAt != null ? formatDateTime(invoice.issuedAt, timezone) : '--'}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">{t('invoices.dueAt')}</dt>
                <dd className="text-sm font-medium">
                  {invoice.dueAt != null ? formatDateTime(invoice.dueAt, timezone) : '--'}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">{t('payments.currency')}</dt>
                <dd className="text-sm font-medium">{invoice.currency}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('invoices.lineItems')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('invoices.description')}</TableHead>
                    <TableHead>{t('invoices.session')}</TableHead>
                    <TableHead className="text-right">{t('invoices.quantity')}</TableHead>
                    <TableHead className="text-right">{t('invoices.unitPrice')}</TableHead>
                    <TableHead className="text-right">{t('invoices.total')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lineItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{item.description}</TableCell>
                      <TableCell>
                        {item.sessionId != null ? (
                          <Link
                            to={`/sessions/${item.sessionId}`}
                            className="text-primary hover:underline"
                          >
                            {item.sessionId}
                          </Link>
                        ) : (
                          '--'
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {Number(item.quantity).toString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(item.unitPriceCents, invoice.currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(item.totalCents, invoice.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell colSpan={4} className="text-right text-muted-foreground">
                      {t('invoices.subtotal')}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCents(invoice.subtotalCents, invoice.currency)}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={4} className="text-right text-muted-foreground">
                      {t('invoices.tax')}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCents(invoice.taxCents, invoice.currency)}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={4} className="text-right font-bold">
                      {t('invoices.total')}
                    </TableCell>
                    <TableCell className="text-right font-bold">
                      {formatCents(invoice.totalCents, invoice.currency)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
