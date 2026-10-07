// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { postMock, toastMock } = vi.hoisted(() => ({ postMock: vi.fn(), toastMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { post: postMock } };
});
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { SessionPaymentTab, type PaymentRecord } from '../session/SessionPaymentTab';

const base: PaymentRecord = {
  id: 1,
  status: 'captured',
  paymentSource: 'card_on_file',
  currency: 'USD',
  preAuthAmountCents: 5000,
  capturedAmountCents: 3000,
  refundedAmountCents: 0,
  failureReason: null,
};

function renderTab(payment: PaymentRecord, canRefund = true): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionPaymentTab
        sessionId="sess_1"
        payment={payment}
        canRefund={canRefund}
        formatCents={(cents) => `$${String(cents)}`}
        timezone="UTC"
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  postMock.mockReset();
  toastMock.mockReset();
});

describe('SessionPaymentTab', () => {
  it('labels a known payment source and shows an unknown one as stored', () => {
    renderTab({ ...base, paymentSource: 'operator' });
    expect(screen.getByText('payments.sources.operator')).toBeDefined();
    cleanup();
    renderTab(base);
    expect(screen.getByText('card_on_file')).toBeDefined();
  });

  it('shows a capture awaiting provider confirmation and why refunds wait', () => {
    renderTab({ ...base, pendingOperation: 'capture' }, false);
    expect(screen.getByText('sessions.pendingOperation.capture')).toBeDefined();
    expect(screen.getByText('sessions.refundAfterConfirmation')).toBeDefined();
    expect(screen.queryByText('sessions.refund')).toBeNull();
  });

  it('shows an adjustment awaiting confirmation', () => {
    renderTab({ ...base, status: 'pre_authorized', pendingOperation: 'adjust' }, false);
    expect(screen.getByText('sessions.pendingOperation.adjust')).toBeDefined();
  });

  it('lists the refund ledger with each state', () => {
    renderTab({
      ...base,
      refundedAmountCents: 500,
      providerRefunds: [
        {
          refundId: 'REF_OK',
          amountCents: 500,
          state: 'succeeded',
          requestedAt: '2026-10-01T10:00:00.000Z',
          settledAt: '2026-10-01T10:01:00.000Z',
        },
        {
          refundId: 'REF_WAIT',
          amountCents: 700,
          state: 'pending',
          requestedAt: '2026-10-02T10:00:00.000Z',
        },
      ],
    });
    expect(screen.getByText('sessions.providerRefunds')).toBeDefined();
    expect(screen.getByText('REF_OK')).toBeDefined();
    expect(screen.getByText('sessions.refundState.succeeded')).toBeDefined();
    expect(screen.getByText('REF_WAIT')).toBeDefined();
    expect(screen.getByText('sessions.refundState.pending')).toBeDefined();
  });

  it('prefills the refund with what is left after pending refunds', () => {
    renderTab({
      ...base,
      providerRefunds: [
        {
          refundId: 'R1',
          amountCents: 1000,
          state: 'pending',
          requestedAt: '2026-10-02T10:00:00Z',
        },
      ],
    });
    fireEvent.click(screen.getByText('sessions.refund'));
    expect(screen.getByLabelText<HTMLInputElement>('sessions.refundAmount').value).toBe('20.00');
  });

  it('tells the operator a pending refund is confirmed later', async () => {
    postMock.mockResolvedValue({ ...base, refundStatus: 'pending' });
    renderTab(base);
    fireEvent.click(screen.getByText('sessions.refund'));
    fireEvent.click(screen.getAllByText('sessions.refundConfirm').at(-1) as HTMLElement);
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'sessions.refundPending' }),
      );
    });
    expect(postMock).toHaveBeenCalledWith('/v1/sessions/sess_1/refund', { amountCents: 3000 });
  });
});
