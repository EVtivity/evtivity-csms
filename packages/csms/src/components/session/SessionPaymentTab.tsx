// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefundButton } from '@/components/refund-button';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime } from '@/lib/timezone';
import { paymentStatusVariant } from '@/lib/status-variants';

/** One entry of the refund ledger (payment_records.provider_refunds). */
export interface ProviderRefund {
  refundId: string;
  amountCents: number;
  state: 'pending' | 'succeeded' | 'failed';
  requestedAt: string;
  settledAt?: string;
}

export interface PaymentRecord {
  id: number;
  status: string;
  paymentSource: string;
  currency: string;
  preAuthAmountCents: number | null;
  capturedAmountCents: number | null;
  refundedAmountCents: number;
  failureReason: string | null;
  /** Operation an asynchronous provider (Adyen) has not confirmed yet. */
  pendingOperation?: 'capture' | 'cancel' | 'adjust' | null;
  providerRefunds?: ProviderRefund[];
}

const PENDING_OPERATION_I18N = {
  capture: 'sessions.pendingOperation.capture',
  cancel: 'sessions.pendingOperation.cancel',
  adjust: 'sessions.pendingOperation.adjust',
} as const;

const REFUND_STATE_I18N = {
  pending: 'sessions.refundState.pending',
  succeeded: 'sessions.refundState.succeeded',
  failed: 'sessions.refundState.failed',
} as const;

const REFUND_STATE_VARIANT = {
  pending: 'warning',
  succeeded: 'success',
  failed: 'destructive',
} as const;

const PAYMENT_STATUS_I18N: Record<string, string> = {
  pending: 'payments.statuses.pending',
  pre_authorized: 'payments.statuses.pre_authorized',
  captured: 'payments.statuses.captured',
  failed: 'payments.statuses.failed',
  cancelled: 'payments.statuses.cancelled',
  refunded: 'payments.statuses.refunded',
  partially_refunded: 'payments.statuses.partially_refunded',
};

/** Captured minus refunded, counting refunds still pending at the provider (as the API does). */
function refundableCents(payment: PaymentRecord): number {
  const pending = (payment.providerRefunds ?? [])
    .filter((r) => r.state === 'pending')
    .reduce((sum, r) => sum + r.amountCents, 0);
  return (payment.capturedAmountCents ?? 0) - payment.refundedAmountCents - pending;
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="text-muted-foreground shrink-0 w-32">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export interface SessionPaymentTabProps {
  sessionId: string;
  payment: PaymentRecord | null;
  canRefund: boolean;
  formatCents: (cents: number | null | undefined, currency: string) => string;
  timezone: string;
  /**
   * Reuse for another payment record (a reservation fee): the card title,
   * the refund endpoint, the query to refresh after a refund, and whether the
   * pre-authorization row applies. Defaults are the session's.
   */
  title?: string;
  refundPath?: string;
  invalidateKey?: readonly unknown[];
  showPreAuth?: boolean;
}

export function SessionPaymentTab({
  sessionId,
  payment,
  canRefund,
  formatCents,
  timezone,
  title,
  refundPath,
  invalidateKey,
  showPreAuth = true,
}: SessionPaymentTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [showRefund, setShowRefund] = useState(false);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundError, setRefundError] = useState('');

  const refundMutation = useMutation({
    mutationFn: (data: { amountCents?: number }) =>
      api.post<{ refundStatus?: 'succeeded' | 'pending' }>(
        refundPath ?? `/v1/sessions/${sessionId}/refund`,
        data,
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: invalidateKey ?? ['sessions'] });
      // An asynchronous provider (Adyen) confirms the refund later by webhook.
      if (result.refundStatus === 'pending') {
        toast({ title: t('sessions.refundPending'), variant: 'success' });
      }
      setShowRefund(false);
      setRefundAmount('');
    },
  });

  function handleRefundConfirm(): boolean {
    if (payment == null) return false;
    const remaining = refundableCents(payment);

    if (refundAmount.trim() === '') {
      refundMutation.mutate({});
      return true;
    }

    const cents = Math.round(parseFloat(refundAmount) * 100);
    if (isNaN(cents) || cents <= 0) {
      setRefundError(t('sessions.refundAmountInvalid'));
      return false;
    }
    if (cents > remaining) {
      setRefundError(t('sessions.refundExceedsRemaining'));
      return false;
    }
    setRefundError('');
    refundMutation.mutate({ amountCents: cents });
    return true;
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{title ?? t('sessions.payment')}</CardTitle>
        </CardHeader>
        <CardContent>
          {payment == null ? (
            <p className="text-center text-sm text-muted-foreground">{t('sessions.noPayment')}</p>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Row label={t('payments.paymentStatus')}>
                  <Badge variant={paymentStatusVariant(payment.status)}>
                    {t(
                      (PAYMENT_STATUS_I18N[payment.status] ??
                        payment.status) as 'payments.statuses.pending',
                      payment.status,
                    )}
                  </Badge>
                </Row>
                <Row label={t('sessions.paymentSource')}>{payment.paymentSource}</Row>
                {showPreAuth && (
                  <Row label={t('sessions.preAuthAmount')}>
                    {formatCents(payment.preAuthAmountCents, payment.currency)}
                  </Row>
                )}
                <Row label={t('sessions.capturedAmount')}>
                  {formatCents(payment.capturedAmountCents, payment.currency)}
                </Row>
                <Row label={t('sessions.refundedAmount')}>
                  {formatCents(payment.refundedAmountCents, payment.currency)}
                </Row>
                {payment.pendingOperation != null && (
                  <Row label={t('sessions.providerConfirmation')}>
                    <Badge variant="warning">
                      {t(PENDING_OPERATION_I18N[payment.pendingOperation])}
                    </Badge>
                  </Row>
                )}
                {payment.failureReason != null && (
                  <Row label={t('sessions.failureReason')}>
                    <span className="text-destructive">{payment.failureReason}</span>
                  </Row>
                )}
              </div>
              {payment.providerRefunds != null && payment.providerRefunds.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">{t('sessions.providerRefunds')}</p>
                  <ul className="space-y-1">
                    {payment.providerRefunds.map((refund) => (
                      <li
                        key={refund.refundId}
                        className="flex flex-wrap items-center gap-2 text-sm"
                      >
                        <span>{formatCents(refund.amountCents, payment.currency)}</span>
                        <Badge variant={REFUND_STATE_VARIANT[refund.state]}>
                          {t(REFUND_STATE_I18N[refund.state])}
                        </Badge>
                        <span className="text-muted-foreground">
                          {formatDateTime(refund.settledAt ?? refund.requestedAt, timezone)}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {refund.refundId}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {payment.pendingOperation === 'capture' && (
                <p className="text-sm text-muted-foreground">
                  {t('sessions.refundAfterConfirmation')}
                </p>
              )}
              {canRefund && (
                <RefundButton
                  label={t('sessions.refund')}
                  onClick={() => {
                    const remaining = refundableCents(payment);
                    setRefundAmount((remaining / 100).toFixed(2));
                    setShowRefund(true);
                  }}
                />
              )}
              {refundMutation.isError && (
                <p className="text-sm text-destructive">
                  {getErrorMessage(refundMutation.error, t)}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showRefund}
        onOpenChange={(open) => {
          if (!open) {
            setShowRefund(false);
            setRefundAmount('');
            setRefundError('');
          }
        }}
        title={t('sessions.refundConfirm')}
        description={t('sessions.refundDescription')}
        confirmLabel={t('sessions.refundConfirm')}
        confirmIcon={<RotateCcw className="h-4 w-4" />}
        onConfirm={handleRefundConfirm}
      >
        <div className="space-y-2">
          <Label htmlFor="session-refund-amount" className="leading-6">
            {t('sessions.refundAmount')}
          </Label>
          <DecimalInput
            id="session-refund-amount"
            decimalScale={2}
            value={refundAmount}
            onChange={(value) => {
              setRefundAmount(value);
              setRefundError('');
            }}
            className={refundError !== '' ? 'border-destructive' : ''}
          />
          {refundError !== '' && <p className="text-sm text-destructive">{refundError}</p>}
        </div>
      </ConfirmDialog>
    </>
  );
}
