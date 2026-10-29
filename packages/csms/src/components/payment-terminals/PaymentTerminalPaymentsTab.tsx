// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '@/components/ui/content-state';
import { Pagination } from '@/components/ui/pagination';
import { TabPanel } from '@/components/ui/tab-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatCents } from '@/lib/formatting';
import { formatDateTime } from '@/lib/timezone';
import {
  PAYMENT_TERMINALS_KEY,
  VOIDABLE_TXN_STATES,
  paymentTerminalKey,
  txnStateLabel,
  txnStateVariant,
  type PaymentTerminal,
  type TerminalTransaction,
} from './payment-terminal-types';

const COLUMN_COUNT = 7;

/**
 * The Payments tab: the terminal's card payments, newest first, each linked to
 * its session and the session's payment. A payment still holding the card can
 * be released (voided) from the notice above the list.
 */
export function PaymentTerminalPaymentsTab({
  terminal,
  timezone,
}: {
  terminal: PaymentTerminal;
  timezone: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Releasing a hold needs both, as the void route does.
  const hasTerminalWrite = useHasPermission('paymentTerminals:write');
  const hasPaymentsWrite = useHasPermission('payments:write');
  const canVoid = hasTerminalWrite && hasPaymentsWrite;
  const [voidOpen, setVoidOpen] = useState(false);
  const { data, isLoading, isError, refetch, page, totalPages, setPage } =
    usePaginatedQuery<TerminalTransaction>(
      [...paymentTerminalKey(terminal.id), 'transactions'],
      `/v1/payment-terminals/${terminal.id}/transactions`,
    );
  const open = data?.find((txn) => VOIDABLE_TXN_STATES.has(txn.state)) ?? null;

  const voidTxn = useMutation({
    mutationFn: (id: string) => api.post(`/v1/payment-terminal-transactions/${id}/void`, {}),
    onSuccess: () => {
      setVoidOpen(false);
      toast({ variant: 'success', title: t('paymentTerminals.payments.voidSuccess') });
      void queryClient.invalidateQueries({ queryKey: PAYMENT_TERMINALS_KEY });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  const na = t('common.na');

  return (
    <TabPanel
      title={t('paymentTerminals.detail.tabs.payments')}
      description={t('paymentTerminals.payments.description')}
      body="flush"
      bodyClassName="space-y-4"
    >
      {open != null && (
        <div className="px-6">
          <Alert variant="info" data-testid="terminal-open-payment">
            <Info className="h-4 w-4" />
            <AlertDescription>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  {t('paymentTerminals.payments.openNotice', {
                    amount: formatCents(open.authorizedCents ?? open.requestedCents, open.currency),
                    state: txnStateLabel(t, open.state),
                  })}
                </span>
                {canVoid && (
                  <Button
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => {
                      setVoidOpen(true);
                    }}
                  >
                    <Ban className="h-4 w-4" />
                    {t('paymentTerminals.payments.void')}
                  </Button>
                )}
              </div>
            </AlertDescription>
          </Alert>
        </div>
      )}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('paymentTerminals.payments.columns.started')}</TableHead>
              <TableHead>{t('paymentTerminals.payments.columns.state')}</TableHead>
              <TableHead>{t('paymentTerminals.payments.columns.hold')}</TableHead>
              <TableHead>{t('paymentTerminals.payments.columns.captured')}</TableHead>
              <TableHead>{t('paymentTerminals.payments.columns.card')}</TableHead>
              <TableHead>{t('paymentTerminals.payments.columns.session')}</TableHead>
              <TableHead>{t('paymentTerminals.payments.columns.payment')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableStateRow colSpan={COLUMN_COUNT}>
                <LoadingState />
              </TableStateRow>
            )}
            {isError && !isLoading && (
              <TableStateRow colSpan={COLUMN_COUNT}>
                <ErrorState
                  onRetry={() => {
                    refetch();
                  }}
                />
              </TableStateRow>
            )}
            {!isLoading && !isError && data?.length === 0 && (
              <TableStateRow colSpan={COLUMN_COUNT}>
                <EmptyState>{t('paymentTerminals.payments.empty')}</EmptyState>
              </TableStateRow>
            )}
            {data?.map((txn) => (
              <TableRow key={txn.id} data-testid={`terminal-payment-row-${txn.id}`}>
                <TableCell className="whitespace-nowrap">
                  {formatDateTime(txn.requestedAt, timezone)}
                </TableCell>
                <TableCell>
                  <span className="flex flex-col gap-1">
                    <Badge variant={txnStateVariant(txn.state)} className="w-fit">
                      {txnStateLabel(t, txn.state)}
                    </Badge>
                    {txn.failureReason != null && (
                      <span className="text-xs text-muted-foreground wrap-anywhere">
                        {txn.failureReason}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatCents(txn.authorizedCents ?? txn.requestedCents, txn.currency)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {txn.capturedCents != null ? formatCents(txn.capturedCents, txn.currency) : na}
                  {txn.refundedCents > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {t('paymentTerminals.payments.refunded', {
                        amount: formatCents(txn.refundedCents, txn.currency),
                      })}
                    </span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {txn.cardLast4 != null
                    ? t('paymentTerminals.payments.cardEnding', {
                        brand: txn.cardBrand ?? '',
                        last4: txn.cardLast4,
                      }).trim()
                    : na}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {txn.sessionId != null ? (
                    <Link to={`/sessions/${txn.sessionId}`} className="text-link hover:underline">
                      {t('paymentTerminals.payments.openSession')}
                    </Link>
                  ) : (
                    na
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {txn.sessionId != null && txn.paymentRecordId != null ? (
                    <Link
                      to={`/sessions/${txn.sessionId}?tab=payment`}
                      className="text-link hover:underline"
                    >
                      {t('paymentTerminals.payments.openPayment')}
                    </Link>
                  ) : (
                    na
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="px-6 pb-6">
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </div>
      <ConfirmDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        title={t('paymentTerminals.payments.void')}
        description={t('paymentTerminals.payments.voidDescription')}
        confirmLabel={t('paymentTerminals.payments.void')}
        isPending={voidTxn.isPending}
        onConfirm={() => {
          if (open != null) voidTxn.mutate(open.id);
          return false;
        }}
      />
    </TabPanel>
  );
}
