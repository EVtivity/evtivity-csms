// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, postMock, permissions } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  permissions: new Set<string>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: postMock } };
});
vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => permissions.has(permission),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ReservationFeePayments } from '../reservation/ReservationFeePayments';

const fee = {
  id: 7,
  chargeType: 'reservation_no_show',
  status: 'captured',
  paymentSource: 'web_portal',
  currency: 'EUR',
  preAuthAmountCents: null,
  capturedAmountCents: 1190,
  refundedAmountCents: 0,
  failureReason: null,
  pendingOperation: null,
  providerRefunds: [],
};

function renderCard(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReservationFeePayments reservationId="rsv_1" timezone="UTC" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
  permissions.clear();
});

describe('ReservationFeePayments', () => {
  it('refunds a fee through the reservation fee refund route', async () => {
    permissions.add('payments:read');
    permissions.add('payments:write');
    getMock.mockResolvedValue([fee]);
    postMock.mockResolvedValue({ ...fee, status: 'refunded', refundStatus: 'succeeded' });
    renderCard();

    expect(await screen.findByText('reservations.feePayment.noShow')).toBeDefined();
    expect(getMock).toHaveBeenCalledWith('/v1/reservations/rsv_1/fee-payments');
    // No hold for a fee: no pre-authorization row.
    expect(screen.queryByText('sessions.preAuthAmount')).toBeNull();

    fireEvent.click(screen.getByText('sessions.refund'));
    fireEvent.click(screen.getAllByText('sessions.refundConfirm').at(-1) as HTMLElement);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/reservations/rsv_1/fee-payments/7/refund', {
        amountCents: 1190,
      });
    });
  });

  it('hides Refund without payments:write', async () => {
    permissions.add('payments:read');
    getMock.mockResolvedValue([fee]);
    renderCard();
    expect(await screen.findByText('reservations.feePayment.noShow')).toBeDefined();
    expect(screen.queryByText('sessions.refund')).toBeNull();
  });

  it('shows nothing and fetches nothing without payments:read', () => {
    renderCard();
    expect(screen.queryByText('reservations.feePayment.noShow')).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });
});
