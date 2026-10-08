// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle, Download, FileMinus, Mail, Printer } from 'lucide-react';
import { BackButton } from '@/components/back-button';
import { EntityNavButtons } from '@/components/entity-nav-buttons';
import { API_BASE_URL } from '@/lib/config';
import { DriverInvoice, INVOICE_STATUS_VARIANT } from '@/components/driver/DriverInvoicesTab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { formatCents, formatTaxPercent } from '@/lib/formatting';
import { describeInvoiceLine } from '@/lib/invoice-lines';
import { formatPeriodMonth, groupLinesByDriver, readBillTo } from '@/lib/fleet-invoice';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { LoadingLogo } from '@/components/loading-logo';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';

interface InvoiceRecord extends DriverInvoice {
  /** Fleet invoice (and its credit note): the billed fleet, period and bill-to snapshot. */
  fleetId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  billTo?: Record<string, unknown> | null;
  sentAt?: string | null;
  overdueNoticeSentAt?: string | null;
  paidAt: string | null;
  paymentReference: string | null;
  creditReason: string | null;
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
  /** Net amount (tax excluded). */
  totalCents: number;
  taxCents: number;
  /** Tax rate as a decimal fraction string ("0.19" is 19%). */
  taxRate: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface InvoiceTaxBreakdownLine {
  taxRate: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
}

interface InvoiceDriver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
}

/** The other side of a credit: the credited invoice, or the credit note that credited it. */
interface InvoiceReference {
  id: string;
  invoiceNumber: string;
  issuedAt: string | null;
  paidAt: string | null;
}

interface InvoiceDetailData {
  invoice: InvoiceRecord;
  lineItems: InvoiceLineItem[];
  driver: InvoiceDriver | null;
  fleet?: { id: string; name: string } | null;
  taxBreakdown: InvoiceTaxBreakdownLine[];
  creditedInvoice: InvoiceReference | null;
  creditNote: InvoiceReference | null;
}

/** A Date as the value of an <input type="datetime-local"> in the browser time zone. */
function toDatetimeLocal(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const CREDIT_REASON_MAX = 500;
const PAYMENT_REFERENCE_MAX = 200;

async function downloadInvoicePdf(invoice: { id: string; invoiceNumber: string }): Promise<void> {
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

export function InvoiceDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('payments:write');
  const [voidOpen, setVoidOpen] = useState(false);
  const [resendOpen, setResendOpen] = useState(false);
  const [paidOpen, setPaidOpen] = useState(false);
  const [paidAt, setPaidAt] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [paidSubmitted, setPaidSubmitted] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [creditReason, setCreditReason] = useState('');
  const [creditSubmitted, setCreditSubmitted] = useState(false);

  const { data, isLoading, isError, error } = useQuery<InvoiceDetailData>({
    queryKey: ['invoices', id],
    queryFn: () => api.get<InvoiceDetailData>(`/v1/invoices/${id ?? ''}`),
    enabled: id != null,
  });

  // Public branding (company.* without the prefix), readable without settings permissions.
  const { data: branding } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Record<string, string>>('/v1/portal/branding'),
  });
  const companyName =
    branding?.['name'] != null && branding['name'] !== '' ? branding['name'] : 'EVtivity';
  const companyLogo =
    branding?.['logo'] != null && branding['logo'] !== '' ? branding['logo'] : null;

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

  function invalidateInvoice(): void {
    void queryClient.invalidateQueries({ queryKey: ['invoices', id] });
    if (data?.invoice.driverId != null) {
      void queryClient.invalidateQueries({
        queryKey: ['drivers', data.invoice.driverId, 'invoices'],
      });
    }
  }

  const markPaidMutation = useMutation({
    mutationFn: (body: { paidAt: string; reference?: string }) =>
      api.patch(`/v1/invoices/${id ?? ''}/paid`, body),
    onSuccess: () => {
      toast({ variant: 'success', title: t('invoices.markPaidSuccess') });
      setPaidOpen(false);
      invalidateInvoice();
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  const creditMutation = useMutation({
    mutationFn: (reason: string) =>
      api.post<{ invoice: { id: string } }>(`/v1/invoices/${id ?? ''}/credit-note`, { reason }),
    onSuccess: (result) => {
      toast({ variant: 'success', title: t('invoices.creditNoteSuccess') });
      setCreditOpen(false);
      // Every invoice query: the credited invoice, the new credit note, and the lists.
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      invalidateInvoice();
      void navigate(`/invoices/${result.invoice.id}`);
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

  const requestedAction = searchParams.get('action');
  useEffect(() => {
    if (data == null || requestedAction == null) return;
    const inv = data.invoice;
    const creditNoteKind = inv.kind === 'credit_note';
    if (requestedAction === 'markPaid' && canWrite && !creditNoteKind && inv.status === 'issued') {
      setPaidAt(toDatetimeLocal(new Date()));
      setPaymentReference('');
      setPaidSubmitted(false);
      setPaidOpen(true);
    } else if (
      requestedAction === 'creditNote' &&
      canWrite &&
      !creditNoteKind &&
      (inv.status === 'issued' || inv.status === 'paid')
    ) {
      setCreditReason('');
      setCreditSubmitted(false);
      setCreditOpen(true);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('action');
    setSearchParams(next, { replace: true });
  }, [data, requestedAction, canWrite, searchParams, setSearchParams]);

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

  const { invoice, lineItems, taxBreakdown, creditedInvoice, creditNote } = data;
  const isCreditNote = invoice.kind === 'credit_note';
  const fleetId = invoice.fleetId ?? null;
  const isFleetInvoice = fleetId != null;
  const billTo = readBillTo(invoice.billTo);
  const driverGroups = isFleetInvoice ? groupLinesByDriver(lineItems) : null;
  const canMarkPaid = canWrite && !isCreditNote && invoice.status === 'issued';
  const canCredit =
    canWrite && !isCreditNote && (invoice.status === 'issued' || invoice.status === 'paid');
  const canVoid = canWrite && invoice.status === 'draft';
  const paidAtInvalid = paidAt === '' || Number.isNaN(new Date(paidAt).getTime());
  const creditReasonInvalid = creditReason.trim() === '';

  function openMarkPaid(): void {
    setPaidAt(toDatetimeLocal(new Date()));
    setPaymentReference('');
    setPaidSubmitted(false);
    setPaidOpen(true);
  }

  function openCredit(): void {
    setCreditReason('');
    setCreditSubmitted(false);
    setCreditOpen(true);
  }

  function handleDownload(): void {
    void downloadInvoicePdf(invoice).catch((err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    });
  }

  function renderLine(item: InvoiceLineItem): React.JSX.Element {
    return (
      <TableRow key={item.id}>
        <TableCell>{describeInvoiceLine(item, t, i18n.language)}</TableCell>
        <TableCell>
          {item.sessionId != null ? (
            <Link to={`/sessions/${item.sessionId}`} className="text-primary hover:underline">
              {item.sessionId}
            </Link>
          ) : (
            '--'
          )}
        </TableCell>
        <TableCell className="text-right">{Number(item.quantity).toString()}</TableCell>
        <TableCell className="text-right">
          {formatCents(item.unitPriceCents, invoice.currency)}
        </TableCell>
        <TableCell className="text-right">
          {t('invoices.taxRateValue', { rate: formatTaxPercent(item.taxRate) })}
        </TableCell>
        <TableCell className="text-right">
          {formatCents(item.totalCents, invoice.currency)}
        </TableCell>
      </TableRow>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <BackButton
            to={
              fleetId != null
                ? `/fleets/${fleetId}?tab=billing`
                : invoice.driverId != null
                  ? `/drivers/${invoice.driverId}?tab=invoices`
                  : '/drivers'
            }
          />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">{invoice.invoiceNumber}</h1>
            {isCreditNote && (
              <p className="text-sm text-muted-foreground">{t('invoices.kinds.credit_note')}</p>
            )}
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
          {canWrite && (invoice.driverId != null || isFleetInvoice) && (
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
          {canMarkPaid && (
            <Button variant="outline" onClick={openMarkPaid}>
              <CheckCircle className="mr-2 h-4 w-4" />
              {t('invoices.markPaid')}
            </Button>
          )}
          {canCredit && (
            <Button variant="destructive" onClick={openCredit}>
              <FileMinus className="mr-2 h-4 w-4" />
              {t('invoices.issueCreditNote')}
            </Button>
          )}
          {canVoid && (
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
        open={paidOpen}
        onOpenChange={setPaidOpen}
        variant="default"
        title={t('invoices.markPaid')}
        description={t('invoices.markPaidDescription')}
        confirmLabel={t('invoices.markPaid')}
        isPending={markPaidMutation.isPending}
        onConfirm={() => {
          setPaidSubmitted(true);
          if (paidAtInvalid) return false;
          const reference = paymentReference.trim();
          markPaidMutation.mutate({
            paidAt: new Date(paidAt).toISOString(),
            ...(reference !== '' ? { reference } : {}),
          });
          return false;
        }}
      >
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="invoice-paid-at">{t('invoices.paymentDate')}</Label>
            <Input
              id="invoice-paid-at"
              type="datetime-local"
              value={paidAt}
              onChange={(e) => {
                setPaidAt(e.target.value);
              }}
            />
            {paidSubmitted && paidAtInvalid && (
              <p className="text-sm text-destructive">{t('invoices.paymentDateRequired')}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="invoice-payment-reference">{t('invoices.paymentReference')}</Label>
            <Input
              id="invoice-payment-reference"
              value={paymentReference}
              maxLength={PAYMENT_REFERENCE_MAX}
              onChange={(e) => {
                setPaymentReference(e.target.value);
              }}
            />
          </div>
        </form>
      </ConfirmDialog>

      <ConfirmDialog
        open={creditOpen}
        onOpenChange={setCreditOpen}
        title={t('invoices.issueCreditNote')}
        description={t('invoices.confirmCreditNote')}
        confirmLabel={t('invoices.issueCreditNote')}
        isPending={creditMutation.isPending}
        onConfirm={() => {
          setCreditSubmitted(true);
          if (creditReasonInvalid) return false;
          creditMutation.mutate(creditReason.trim());
          return false;
        }}
      >
        <form
          noValidate
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <Label htmlFor="invoice-credit-reason">{t('invoices.creditReason')}</Label>
          <Textarea
            id="invoice-credit-reason"
            value={creditReason}
            maxLength={CREDIT_REASON_MAX}
            onChange={(e) => {
              setCreditReason(e.target.value);
            }}
          />
          {creditSubmitted && creditReasonInvalid && (
            <p className="text-sm text-destructive">{t('invoices.creditReasonRequired')}</p>
          )}
        </form>
      </ConfirmDialog>

      <ConfirmDialog
        open={resendOpen}
        onOpenChange={setResendOpen}
        variant="default"
        title={t('invoices.resendInvoice')}
        description={
          isFleetInvoice ? t('invoices.confirmResendFleet') : t('invoices.confirmResend')
        }
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
            <CardTitle>
              {isCreditNote ? `${t('invoices.kinds.credit_note')} ` : ''}
              {invoice.invoiceNumber}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">{t('invoices.billedTo')}</dt>
                <dd className="text-sm font-medium">
                  {billTo != null ? (
                    <div data-testid="invoice-bill-to">
                      <div>{billTo.name}</div>
                      {billTo.lines.map((line) => (
                        <div key={line} className="font-normal text-muted-foreground">
                          {line}
                        </div>
                      ))}
                      {billTo.taxId != null && (
                        <div className="font-normal text-muted-foreground">
                          {t('invoices.taxId', { id: billTo.taxId })}
                        </div>
                      )}
                    </div>
                  ) : invoice.driverId != null ? (
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
              {isFleetInvoice && (
                <div>
                  <dt className="text-sm text-muted-foreground">{t('invoices.fleet')}</dt>
                  <dd className="text-sm font-medium">
                    <Link
                      to={`/fleets/${fleetId}?tab=billing`}
                      className="text-primary hover:underline"
                    >
                      {data.fleet?.name ?? fleetId}
                    </Link>
                  </dd>
                </div>
              )}
              {invoice.periodStart != null && (
                <div>
                  <dt className="text-sm text-muted-foreground">{t('invoices.period')}</dt>
                  <dd className="text-sm font-medium">
                    {formatPeriodMonth(invoice.periodStart, i18n.language)}
                  </dd>
                </div>
              )}
              {isFleetInvoice && (
                <div>
                  <dt className="text-sm text-muted-foreground">{t('invoices.sentAt')}</dt>
                  <dd className="text-sm font-medium">
                    {invoice.sentAt != null
                      ? formatDateTime(invoice.sentAt, timezone)
                      : t('invoices.notSent')}
                  </dd>
                </div>
              )}
              {isFleetInvoice && invoice.overdueNoticeSentAt != null && (
                <div>
                  <dt className="text-sm text-muted-foreground">
                    {t('invoices.overdueNoticeSentAt')}
                  </dt>
                  <dd className="text-sm font-medium">
                    {formatDateTime(invoice.overdueNoticeSentAt, timezone)}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-sm text-muted-foreground">{t('invoices.issuedAt')}</dt>
                <dd className="text-sm font-medium">
                  {invoice.issuedAt != null ? formatDateTime(invoice.issuedAt, timezone) : '--'}
                </dd>
              </div>
              {!isCreditNote && (
                <div>
                  <dt className="text-sm text-muted-foreground">{t('invoices.dueAt')}</dt>
                  <dd className="text-sm font-medium">
                    {invoice.dueAt != null ? formatDateTime(invoice.dueAt, timezone) : '--'}
                  </dd>
                </div>
              )}
              {creditedInvoice != null && (
                <div>
                  <dt className="text-sm text-muted-foreground">{t('invoices.creditsInvoice')}</dt>
                  <dd className="text-sm font-medium">
                    <Link
                      to={`/invoices/${creditedInvoice.id}`}
                      className="text-primary hover:underline"
                    >
                      {creditedInvoice.invoiceNumber}
                    </Link>
                  </dd>
                </div>
              )}
              {creditNote != null && (
                <div>
                  <dt className="text-sm text-muted-foreground">{t('invoices.creditedBy')}</dt>
                  <dd className="text-sm font-medium">
                    <Link
                      to={`/invoices/${creditNote.id}`}
                      className="text-primary hover:underline"
                    >
                      {creditNote.invoiceNumber}
                    </Link>
                  </dd>
                </div>
              )}
              {invoice.creditReason != null && (
                <div>
                  <dt className="text-sm text-muted-foreground">{t('invoices.creditReason')}</dt>
                  <dd className="text-sm font-medium break-words">{invoice.creditReason}</dd>
                </div>
              )}
              <div>
                <dt className="text-sm text-muted-foreground">{t('payments.currency')}</dt>
                <dd className="text-sm font-medium">{invoice.currency}</dd>
              </div>
              {invoice.paidAt != null && (
                <div>
                  <dt className="text-sm text-muted-foreground">{t('invoices.paidAt')}</dt>
                  <dd className="text-sm font-medium">
                    {formatDateTime(invoice.paidAt, timezone)}
                  </dd>
                </div>
              )}
              {invoice.paymentReference != null && (
                <div>
                  <dt className="text-sm text-muted-foreground">
                    {t('invoices.paymentReference')}
                  </dt>
                  <dd className="text-sm font-medium break-words">{invoice.paymentReference}</dd>
                </div>
              )}
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
                    <TableHead className="text-right">{t('invoices.taxRate')}</TableHead>
                    <TableHead className="text-right">{t('invoices.amount')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {driverGroups != null
                    ? driverGroups.map((group) => {
                        const name =
                          group.driverName !== '' ? group.driverName : t('invoices.unknownDriver');
                        return (
                          <Fragment key={group.driverId ?? 'unknown'}>
                            <TableRow data-testid="invoice-driver-group">
                              <TableCell colSpan={6} className="font-semibold">
                                {group.driverId != null ? (
                                  <Link
                                    to={`/drivers/${group.driverId}`}
                                    className="text-primary hover:underline"
                                  >
                                    {name}
                                  </Link>
                                ) : (
                                  name
                                )}
                              </TableCell>
                            </TableRow>
                            {group.items.map((item) => renderLine(item))}
                            <TableRow>
                              <TableCell colSpan={5} className="text-right text-muted-foreground">
                                {t('invoices.driverSubtotal', { driver: name })}
                              </TableCell>
                              <TableCell className="text-right">
                                {formatCents(group.netCents, invoice.currency)}
                              </TableCell>
                            </TableRow>
                          </Fragment>
                        );
                      })
                    : lineItems.map((item) => renderLine(item))}
                  <TableRow>
                    <TableCell colSpan={5} className="text-right text-muted-foreground">
                      {t('invoices.subtotalNet')}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCents(invoice.subtotalCents, invoice.currency)}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={5} className="text-right text-muted-foreground">
                      {t('invoices.totalTax')}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCents(invoice.taxCents, invoice.currency)}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={5} className="text-right font-bold">
                      {t('invoices.total')}
                    </TableCell>
                    <TableCell className="text-right font-bold">
                      {formatCents(invoice.totalCents, invoice.currency)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t('invoices.amountsExcludeTax')}</p>
            {isCreditNote && creditedInvoice?.paidAt != null && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('invoices.creditNotePaidNote')}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('invoices.taxSummary')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('invoices.taxRate')}</TableHead>
                    <TableHead className="text-right">{t('invoices.netAmount')}</TableHead>
                    <TableHead className="text-right">{t('invoices.tax')}</TableHead>
                    <TableHead className="text-right">{t('invoices.grossAmount')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {taxBreakdown.map((line) => (
                    <TableRow key={line.taxRate}>
                      <TableCell>
                        {t('invoices.taxRateValue', { rate: formatTaxPercent(line.taxRate) })}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(line.netCents, invoice.currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(line.taxCents, invoice.currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(line.grossCents, invoice.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="print-hidden">
        <EntityHistoryTab entityType="invoice" entityId={id ?? ''} title={t('audit.history')} />
      </div>
    </div>
  );
}
