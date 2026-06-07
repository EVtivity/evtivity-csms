// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
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
import { API_BASE_URL } from '@/lib/config';
import { getErrorMessage } from '@/lib/error-message';
import { formatCents } from '@/lib/formatting';
import { formatDateTime } from '@/lib/timezone';
import { LoadingLogo } from '@/components/loading-logo';

export interface DriverInvoice {
  id: string;
  invoiceNumber: string;
  driverId: string | null;
  status: 'draft' | 'issued' | 'paid' | 'void';
  issuedAt: string | null;
  dueAt: string | null;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  createdAt: string;
}

export const INVOICE_STATUS_VARIANT: Record<
  DriverInvoice['status'],
  'outline' | 'warning' | 'success' | 'secondary'
> = {
  draft: 'outline',
  issued: 'warning',
  paid: 'success',
  void: 'secondary',
};

export function downloadInvoiceJson(
  invoice: Pick<DriverInvoice, 'id' | 'invoiceNumber'>,
): Promise<void> {
  return fetch(`${API_BASE_URL}/v1/invoices/${invoice.id}/download`, { credentials: 'include' })
    .then((res) => {
      if (!res.ok) throw new Error(`Download failed (${String(res.status)})`);
      return res.blob();
    })
    .then((blob) => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${invoice.invoiceNumber}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
}

interface Props {
  driverId: string;
  timezone: string;
}

export function DriverInvoicesTab({ driverId, timezone }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canWrite = useHasPermission('payments:write');
  const [page, setPage] = useState(1);
  const limit = 25;

  const [generateOpen, setGenerateOpen] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['drivers', driverId, 'invoices', page],
    queryFn: () =>
      api.get<{ data: DriverInvoice[]; total: number }>(
        `/v1/invoices?driverId=${driverId}&page=${String(page)}&limit=${String(limit)}`,
      ),
    enabled: driverId !== '',
  });

  const generateMutation = useMutation({
    mutationFn: () =>
      api.post('/v1/invoices/aggregated', {
        driverId,
        startDate: new Date(startDate).toISOString(),
        endDate: new Date(`${endDate}T23:59:59.999`).toISOString(),
      }),
    onSuccess: () => {
      toast({ variant: 'success', title: t('invoices.generateSuccess') });
      resetGenerate();
      void queryClient.invalidateQueries({ queryKey: ['drivers', driverId, 'invoices'] });
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  function resetGenerate(): void {
    setGenerateOpen(false);
    setStartDate('');
    setEndDate('');
    setHasSubmitted(false);
    generateMutation.reset();
  }

  function openGenerate(): void {
    // YYYY-MM-DD in the browser's local timezone (en-CA formats as ISO-like).
    const today = new Date().toLocaleDateString('en-CA');
    setStartDate(today);
    setEndDate(today);
    setGenerateOpen(true);
  }

  function getValidationErrors(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (startDate === '') errs['startDate'] = t('validation.required');
    if (endDate === '') errs['endDate'] = t('validation.required');
    // Same-day ranges are valid: the end date is inclusive of the whole day.
    if (startDate !== '' && endDate !== '' && new Date(endDate) < new Date(startDate)) {
      errs['endDate'] = t('validation.invalidValue');
    }
    return errs;
  }

  const errors = getValidationErrors();

  function handleGenerate(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    generateMutation.mutate();
  }

  const totalPages = data != null ? Math.max(1, Math.ceil(data.total / limit)) : 1;
  const invoices = data?.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('invoices.title')}</CardTitle>
        {canWrite && <Button onClick={openGenerate}>{t('invoices.generateInvoice')}</Button>}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingLogo size="inline" />
        ) : invoices.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">{t('invoices.noInvoices')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('invoices.invoiceNumber')}</TableHead>
                    <TableHead>{t('common.status')}</TableHead>
                    <TableHead>{t('invoices.issuedAt')}</TableHead>
                    <TableHead>{t('invoices.dueAt')}</TableHead>
                    <TableHead className="text-right">{t('invoices.total')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((inv) => (
                    <TableRow
                      key={inv.id}
                      className="cursor-pointer"
                      data-testid={`invoice-row-${inv.id}`}
                      onClick={() => {
                        void navigate(`/invoices/${inv.id}`);
                      }}
                    >
                      <TableCell
                        className="font-medium text-primary"
                        data-testid="row-click-target"
                      >
                        {inv.invoiceNumber}
                      </TableCell>
                      <TableCell>
                        <Badge variant={INVOICE_STATUS_VARIANT[inv.status]}>
                          {t(
                            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                            `invoices.status.${inv.status}` as never,
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {inv.issuedAt != null ? formatDateTime(inv.issuedAt, timezone) : '--'}
                      </TableCell>
                      <TableCell>
                        {inv.dueAt != null ? formatDateTime(inv.dueAt, timezone) : '--'}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(inv.totalCents, inv.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {totalPages > 1 && (
              <div className="mt-4">
                <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
              </div>
            )}
          </>
        )}
      </CardContent>
      <Dialog
        open={generateOpen}
        onOpenChange={(open) => {
          if (!open) resetGenerate();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('invoices.generateInvoice')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleGenerate} noValidate className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('invoices.generateInvoiceDescription')}
            </p>
            <div className="space-y-2">
              <Label htmlFor="invoice-start-date">{t('invoices.startDate')}</Label>
              <Input
                id="invoice-start-date"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                }}
                className={hasSubmitted && errors['startDate'] != null ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors['startDate'] != null && (
                <p className="text-sm text-destructive">{errors['startDate']}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="invoice-end-date">{t('invoices.endDate')}</Label>
              <Input
                id="invoice-end-date"
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                }}
                className={hasSubmitted && errors['endDate'] != null ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors['endDate'] != null && (
                <p className="text-sm text-destructive">{errors['endDate']}</p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={resetGenerate}
                disabled={generateMutation.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={generateMutation.isPending} className="relative">
                {generateMutation.isPending && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  </div>
                )}
                <span className={generateMutation.isPending ? 'invisible' : ''}>
                  {t('invoices.generateInvoice')}
                </span>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
