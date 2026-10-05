// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SessionPaymentTab, type PaymentRecord } from '@/components/session/SessionPaymentTab';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { formatCents } from '@/lib/formatting';

/** A cancellation or no-show fee payment record of a reservation. */
export interface FeePaymentRecord extends PaymentRecord {
  chargeType: 'reservation_cancellation' | 'reservation_no_show';
}

const FEE_TITLE_I18N = {
  reservation_cancellation: 'reservations.feePayment.cancellation',
  reservation_no_show: 'reservations.feePayment.noShow',
} as const;

/** Query key of a reservation's fee payments (`payment.settled` refreshes every reservation's). */
export function reservationFeePaymentsKey(reservationId: string): readonly unknown[] {
  return ['reservation-fee-payments', reservationId];
}

export interface ReservationFeePaymentsProps {
  reservationId: string;
  timezone: string;
}

/**
 * The fee payments of a reservation, each with the refund dialog of a session
 * payment. Shown with `payments:read`; Refund needs `payments:write`.
 */
export function ReservationFeePayments({
  reservationId,
  timezone,
}: ReservationFeePaymentsProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const canRead = useHasPermission('payments:read');
  const canWrite = useHasPermission('payments:write');
  const queryKey = reservationFeePaymentsKey(reservationId);

  const { data } = useQuery({
    queryKey,
    queryFn: () => api.get<FeePaymentRecord[]>(`/v1/reservations/${reservationId}/fee-payments`),
    enabled: canRead,
    staleTime: 30_000,
  });

  if (!canRead || data == null || data.length === 0) return null;

  return (
    <div className="space-y-6">
      {data.map((payment) => (
        <SessionPaymentTab
          key={payment.id}
          sessionId=""
          payment={payment}
          // A capture the provider has not confirmed cannot be refunded yet (409 PAYMENT_OPERATION_PENDING).
          canRefund={
            canWrite &&
            (payment.status === 'captured' || payment.status === 'partially_refunded') &&
            payment.pendingOperation !== 'capture'
          }
          formatCents={formatCents}
          timezone={timezone}
          title={t(FEE_TITLE_I18N[payment.chargeType])}
          refundPath={`/v1/reservations/${reservationId}/fee-payments/${String(payment.id)}/refund`}
          invalidateKey={queryKey}
          showPreAuth={false}
        />
      ))}
    </div>
  );
}
