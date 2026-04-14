// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefundButton } from '@/components/refund-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { paymentStatusVariant } from '@/lib/status-variants';

interface PaymentRecord {
  id: number;
  status: string;
  paymentSource: string;
  currency: string;
  preAuthAmountCents: number | null;
  capturedAmountCents: number | null;
  refundedAmountCents: number;
  failureReason: string | null;
}

const PAYMENT_STATUS_I18N: Record<string, string> = {
  pending: 'payments.statuses.pending',
  pre_authorized: 'payments.statuses.pre_authorized',
  captured: 'payments.statuses.captured',
  failed: 'payments.statuses.failed',
  cancelled: 'payments.statuses.cancelled',
  refunded: 'payments.statuses.refunded',
  partially_refunded: 'payments.statuses.partially_refunded',
};

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
}

export function SessionPaymentTab({
  sessionId,
  payment,
  canRefund,
  formatCents,
}: SessionPaymentTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [showRefund, setShowRefund] = useState(false);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundError, setRefundError] = useState('');

  const refundMutation = useMutation({
    mutationFn: (data: { amountCents?: number }) =>
      api.post(`/v1/sessions/${sessionId}/refund`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', sessionId] });
      setShowRefund(false);
      setRefundAmount('');
    },
  });

  function handleRefundConfirm(): boolean {
    if (payment == null) return false;
    const remaining = (payment.capturedAmountCents ?? 0) - payment.refundedAmountCents;

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
          <CardTitle>{t('sessions.payment')}</CardTitle>
        </CardHeader>
        <CardContent>
          {payment == null ? (
            <p className="text-sm text-muted-foreground">{t('sessions.noPayment')}</p>
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
                <Row label={t('sessions.preAuthAmount')}>
                  {formatCents(payment.preAuthAmountCents, payment.currency)}
                </Row>
                <Row label={t('sessions.capturedAmount')}>
                  {formatCents(payment.capturedAmountCents, payment.currency)}
                </Row>
                <Row label={t('sessions.refundedAmount')}>
                  {formatCents(payment.refundedAmountCents, payment.currency)}
                </Row>
                {payment.failureReason != null && (
                  <Row label={t('sessions.failureReason')}>
                    <span className="text-destructive">{payment.failureReason}</span>
                  </Row>
                )}
              </div>
              {canRefund && (
                <RefundButton
                  label={t('sessions.refund')}
                  onClick={() => {
                    const remaining =
                      (payment.capturedAmountCents ?? 0) - payment.refundedAmountCents;
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
          <Label htmlFor="session-refund-amount">{t('sessions.refundAmount')}</Label>
          <Input
            id="session-refund-amount"
            type="number"
            step="0.01"
            min="0.01"
            value={refundAmount}
            onChange={(e) => {
              setRefundAmount(e.target.value);
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
