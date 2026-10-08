// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Download, FileMinus, Mail } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { LoadingLogo } from '@/components/loading-logo';
import { INVOICE_STATUS_VARIANT } from '@/components/driver/DriverInvoicesTab';
import type { DriverInvoice } from '@/components/driver/DriverInvoicesTab';
import { api, ApiError } from '@/lib/api';
import { API_BASE_URL } from '@/lib/config';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatCents, formatNumber } from '@/lib/formatting';
import { currentMonth, formatPeriodMonth, previousMonth } from '@/lib/fleet-invoice';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

/** Why the fleet invoice leaves an unbilled account session off. */
export type FleetInvoiceExclusion = 'other_currency' | 'zero_cost' | 'uncosted';

/** GET /v1/fleets/:id/billing/unbilled */
export interface FleetUnbilledPreview {
  fleetId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  sessionCount: number;
  energyWh: number;
  netCents: number;
  taxCents: number;
  totalCents: number;
  drivers: Array<{
    driverId: string | null;
    driverName: string;
    sessionCount: number;
    energyWh: number;
    netCents: number;
    taxCents: number;
    totalCents: number;
  }>;
  excluded: Array<{
    sessionId: string;
    driverId: string | null;
    driverName: string;
    endedAt: string | null;
    reason: FleetInvoiceExclusion;
    currency: string;
    finalCostCents: number | null;
  }>;
  excludedCount: number;
  existingInvoice: { id: string; invoiceNumber: string; status: string } | null;
}

/** A row of GET /v1/fleets/:id/invoices. */
export interface FleetInvoiceRow extends DriverInvoice {
  fleetId: string | null;
  fleetName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  sentAt: string | null;
}

const PAGE_SIZE = 10;

async function downloadPdf(invoice: { id: string; invoiceNumber: string }): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/v1/invoices/${invoice.id}/pdf`, {
    credentials: 'include',
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const blob = await res.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${invoice.invoiceNumber}.pdf`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function kwh(energyWh: number): string {
  return `${formatNumber(energyWh / 1000, 2)} kWh`;
}

/** The fleet invoice on demand: the unbilled preview, Generate, and the fleet's invoices. */
export function FleetInvoicesCard({ fleetId }: { fleetId: string }): React.JSX.Element | null {
  const canRead = useHasPermission('payments:read');
  if (!canRead) return null;
  return (
    <>
      <FleetUnbilledCard fleetId={fleetId} />
      <FleetInvoiceList fleetId={fleetId} />
    </>
  );
}

function FleetUnbilledCard({ fleetId }: { fleetId: string }): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('payments:write');
  const [period, setPeriod] = useState(previousMonth());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['fleets', fleetId, 'unbilled', period],
    queryFn: () =>
      api.get<FleetUnbilledPreview>(`/v1/fleets/${fleetId}/billing/unbilled?period=${period}`),
    enabled: /^\d{4}-\d{2}$/.test(period),
  });

  const generate = useMutation({
    mutationFn: () =>
      api.post<{ emailed: boolean; invoice: { id: string } }>(`/v1/fleets/${fleetId}/invoices`, {
        period,
      }),
    onSuccess: (result) => {
      toast({
        variant: 'success',
        title: result.emailed
          ? t('fleets.invoices.generated')
          : t('fleets.invoices.generatedNotEmailed'),
      });
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
      setConfirmOpen(false);
    },
  });

  const monthLabel = formatPeriodMonth(period, i18n.language);
  const money = (cents: number): string => formatCents(cents, data?.currency ?? 'USD');
  const canGenerate =
    canWrite && data != null && data.sessionCount > 0 && data.existingInvoice == null;

  return (
    <Card data-testid="fleet-billing-unbilled">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle>{t('fleets.invoices.unbilledTitle')}</CardTitle>
          <CardDescription>{t('fleets.invoices.unbilledDescription')}</CardDescription>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="fleet-invoice-period">{t('fleets.invoices.period')}</Label>
            <Input
              id="fleet-invoice-period"
              type="month"
              value={period}
              max={currentMonth()}
              onChange={(e) => {
                setPeriod(e.target.value);
              }}
            />
          </div>
          {canWrite && (
            <Button
              disabled={!canGenerate || generate.isPending}
              onClick={() => {
                setConfirmOpen(true);
              }}
            >
              {t('fleets.invoices.generate')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {isLoading ? (
          <LoadingLogo size="inline" />
        ) : isError || data == null ? (
          <p className="text-destructive">{t('common.loadError')}</p>
        ) : (
          <>
            {data.existingInvoice != null && (
              <p className="rounded-md border p-3" data-testid="fleet-invoice-existing">
                {t('fleets.invoices.existingInvoice', {
                  number: data.existingInvoice.invoiceNumber,
                })}{' '}
                <Link
                  to={`/invoices/${data.existingInvoice.id}`}
                  className="text-primary hover:underline"
                >
                  {data.existingInvoice.invoiceNumber}
                </Link>
              </p>
            )}
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <div>
                <dt className="text-muted-foreground">{t('fleets.invoices.sessions')}</dt>
                <dd className="font-medium">{data.sessionCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('fleets.invoices.energy')}</dt>
                <dd className="font-medium">{kwh(data.energyWh)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('fleets.invoices.net')}</dt>
                <dd className="font-medium">{money(data.netCents)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('fleets.invoices.tax')}</dt>
                <dd className="font-medium">{money(data.taxCents)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('fleets.invoices.total')}</dt>
                <dd className="font-medium">{money(data.totalCents)}</dd>
              </div>
            </dl>
            {data.drivers.length === 0 ? (
              <p className="text-muted-foreground">{t('fleets.invoices.noUnbilled')}</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('fleets.invoices.driver')}</TableHead>
                      <TableHead className="text-right">{t('fleets.invoices.sessions')}</TableHead>
                      <TableHead className="text-right">{t('fleets.invoices.energy')}</TableHead>
                      <TableHead className="text-right">{t('fleets.invoices.total')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.drivers.map((driver) => (
                      <TableRow key={driver.driverId ?? 'unknown'}>
                        <TableCell>
                          {driver.driverId != null ? (
                            <Link
                              to={`/drivers/${driver.driverId}`}
                              className="text-primary hover:underline"
                            >
                              {driver.driverName !== ''
                                ? driver.driverName
                                : t('invoices.unknownDriver')}
                            </Link>
                          ) : (
                            t('invoices.unknownDriver')
                          )}
                        </TableCell>
                        <TableCell className="text-right">{driver.sessionCount}</TableCell>
                        <TableCell className="text-right">{kwh(driver.energyWh)}</TableCell>
                        <TableCell className="text-right">{money(driver.totalCents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {data.excludedCount > 0 && (
              <div className="space-y-2" data-testid="fleet-invoice-excluded">
                <p className="font-medium">
                  {t('fleets.invoices.excludedTitle', { count: data.excludedCount })}
                </p>
                <ul className="space-y-1 text-muted-foreground">
                  {data.excluded.map((session) => (
                    <li key={session.sessionId}>
                      <Link
                        to={`/sessions/${session.sessionId}`}
                        className="text-primary hover:underline"
                      >
                        {session.sessionId}
                      </Link>
                      {' · '}
                      {session.driverName !== '' ? session.driverName : t('invoices.unknownDriver')}
                      {' · '}
                      {t(
                        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                        `fleets.invoices.excludedReasons.${session.reason}` as never,
                      )}
                      {session.finalCostCents != null && session.reason === 'other_currency'
                        ? ` (${formatCents(session.finalCostCents, session.currency)})`
                        : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        variant="default"
        title={t('fleets.invoices.generateTitle')}
        description={t('fleets.invoices.generateConfirm', {
          period: monthLabel,
          total: data != null ? money(data.totalCents) : '',
        })}
        confirmLabel={t('fleets.invoices.generate')}
        isPending={generate.isPending}
        onConfirm={() => {
          generate.mutate();
          return false;
        }}
      />
    </Card>
  );
}

function FleetInvoiceList({ fleetId }: { fleetId: string }): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const timezone = useUserTimezone();
  const canWrite = useHasPermission('payments:write');
  const [page, setPage] = useState(1);
  const [sendTarget, setSendTarget] = useState<FleetInvoiceRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['fleets', fleetId, 'invoices', page],
    queryFn: () =>
      api.get<{ data: FleetInvoiceRow[]; total: number }>(
        `/v1/fleets/${fleetId}/invoices?page=${String(page)}&limit=${String(PAGE_SIZE)}`,
      ),
  });

  const send = useMutation({
    mutationFn: (invoiceId: string) => api.post(`/v1/invoices/${invoiceId}/send`, {}),
    onSuccess: () => {
      toast({ variant: 'success', title: t('fleets.invoices.sent') });
      setSendTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId, 'invoices'] });
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
      setSendTarget(null);
    },
  });

  const rows = data?.data ?? [];
  const totalPages = data != null ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  function handleDownload(row: FleetInvoiceRow): void {
    void downloadPdf(row).catch((err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    });
  }

  return (
    <Card data-testid="fleet-billing-invoices">
      <CardHeader>
        <CardTitle>{t('fleets.invoices.listTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingLogo size="inline" />
        ) : rows.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('fleets.invoices.noInvoices')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('invoices.invoiceNumber')}</TableHead>
                    <TableHead>{t('invoices.period')}</TableHead>
                    <TableHead>{t('common.status')}</TableHead>
                    <TableHead>{t('invoices.issuedAt')}</TableHead>
                    <TableHead>{t('invoices.dueAt')}</TableHead>
                    <TableHead>{t('invoices.sentAt')}</TableHead>
                    <TableHead className="text-right">{t('invoices.total')}</TableHead>
                    <TableHead className="text-right">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const isCreditNote = row.kind === 'credit_note';
                    return (
                      <TableRow key={row.id} data-testid={`fleet-invoice-row-${row.id}`}>
                        <TableCell className="font-medium">
                          <Link to={`/invoices/${row.id}`} className="text-primary hover:underline">
                            {row.invoiceNumber}
                          </Link>
                          {isCreditNote && (
                            <Badge variant="outline" className="ml-2">
                              {t('invoices.kinds.credit_note')}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>{formatPeriodMonth(row.periodStart, i18n.language)}</TableCell>
                        <TableCell>
                          <Badge variant={INVOICE_STATUS_VARIANT[row.status]}>
                            {t(
                              // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                              `invoices.status.${row.status}` as never,
                            )}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {row.issuedAt != null ? formatDateTime(row.issuedAt, timezone) : '--'}
                        </TableCell>
                        <TableCell>
                          {!isCreditNote && row.dueAt != null
                            ? formatDateTime(row.dueAt, timezone)
                            : '--'}
                        </TableCell>
                        <TableCell>
                          {row.sentAt != null
                            ? formatDateTime(row.sentAt, timezone)
                            : t('invoices.notSent')}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatCents(row.totalCents, row.currency)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t('invoices.download')}
                              title={t('invoices.download')}
                              onClick={() => {
                                handleDownload(row);
                              }}
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                            {canWrite && (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t('fleets.invoices.send')}
                                title={t('fleets.invoices.send')}
                                onClick={() => {
                                  setSendTarget(row);
                                }}
                              >
                                <Mail className="h-4 w-4" />
                              </Button>
                            )}
                            {canWrite && !isCreditNote && row.status === 'issued' && (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t('invoices.markPaid')}
                                title={t('invoices.markPaid')}
                                onClick={() => {
                                  void navigate(`/invoices/${row.id}?action=markPaid`);
                                }}
                              >
                                <CheckCircle className="h-4 w-4" />
                              </Button>
                            )}
                            {canWrite &&
                              !isCreditNote &&
                              (row.status === 'issued' || row.status === 'paid') && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={t('invoices.issueCreditNote')}
                                  title={t('invoices.issueCreditNote')}
                                  onClick={() => {
                                    void navigate(`/invoices/${row.id}?action=creditNote`);
                                  }}
                                >
                                  <FileMinus className="h-4 w-4" />
                                </Button>
                              )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
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
      <ConfirmDialog
        open={sendTarget != null}
        onOpenChange={(open) => {
          if (!open) setSendTarget(null);
        }}
        variant="default"
        title={t('fleets.invoices.sendTitle')}
        description={t('fleets.invoices.sendConfirm', { number: sendTarget?.invoiceNumber ?? '' })}
        confirmLabel={t('fleets.invoices.send')}
        isPending={send.isPending}
        onConfirm={() => {
          if (sendTarget != null) send.mutate(sendTarget.id);
          return false;
        }}
      />
    </Card>
  );
}
