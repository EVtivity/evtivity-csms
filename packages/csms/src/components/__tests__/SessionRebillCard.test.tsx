// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { postMock, toastMock, permissions } = vi.hoisted(() => ({
  postMock: vi.fn(),
  toastMock: vi.fn(),
  permissions: new Set(['sessions:write', 'payments:write']),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
  }),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { post: postMock }, ApiError };
});

vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => permissions.has(permission),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { ApiError } from '@/lib/api';
import { SessionRebillCard, type SessionRebillCardProps } from '../session/SessionRebillCard';

const UNBILLED: SessionRebillCardProps['session'] = {
  id: 'ses_1',
  status: 'faulted',
  stoppedReason: 'EndRequestFailed',
  rebillStatus: null,
  finalCostCents: 0,
  currency: 'USD',
  rebillable: true,
  rebillBlockedReason: null,
};

function renderCard(overrides: Partial<SessionRebillCardProps['session']> = {}): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SessionRebillCard session={{ ...UNBILLED, ...overrides }} />
    </QueryClientProvider>,
  );
}

const billButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /sessions\.rebill\.button/ });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  permissions.clear();
  permissions.add('sessions:write');
  permissions.add('payments:write');
});

describe('SessionRebillCard', () => {
  it('renders nothing for a session the CSMS ended normally', () => {
    renderCard({ status: 'completed', stoppedReason: 'EVDisconnected' });
    expect(screen.queryByTestId('session-rebill')).toBeNull();
    cleanup();
    renderCard({ status: 'faulted', stoppedReason: 'PaymentFailed' });
    expect(screen.queryByTestId('session-rebill')).toBeNull();
  });

  it('bills the session after confirmation and shows the result', async () => {
    postMock.mockResolvedValue({ rebillStatus: 'billed', result: 'charged', manualReason: null });
    renderCard();
    expect(screen.getByText('sessions.rebill.unbilledBadge')).toBeTruthy();
    fireEvent.click(billButton());
    expect(screen.getByText('sessions.rebill.confirmDescription')).toBeTruthy();
    const confirm = screen
      .getAllByRole('button', { name: /sessions\.rebill\.button/ })
      .find((b) => b.closest('[role="dialog"]') != null);
    fireEvent.click(confirm as HTMLElement);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/sessions/ses_1/rebill', {});
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        title: 'sessions.rebill.charged',
        variant: 'success',
      });
    });
  });

  it('warns when the session falls back to manual billing', async () => {
    postMock.mockResolvedValue({
      rebillStatus: 'manual',
      result: 'manual',
      manualReason: 'no_payment_method',
    });
    renderCard();
    fireEvent.click(billButton());
    const confirm = screen
      .getAllByRole('button', { name: /sessions\.rebill\.button/ })
      .find((b) => b.closest('[role="dialog"]') != null);
    fireEvent.click(confirm as HTMLElement);
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        title: 'sessions.rebill.manual',
        description: 'sessions.rebill.manualReason.no_payment_method',
        variant: 'warning',
      });
    });
  });

  it('shows the refusal reason of the API', async () => {
    postMock.mockRejectedValue(
      new ApiError(409, {
        error: 'Session cannot be re-billed',
        code: 'SESSION_REBILL_NOT_ELIGIBLE',
        details: { reason: 'paid' },
      }),
    );
    renderCard();
    fireEvent.click(billButton());
    const confirm = screen
      .getAllByRole('button', { name: /sessions\.rebill\.button/ })
      .find((b) => b.closest('[role="dialog"]') != null);
    fireEvent.click(confirm as HTMLElement);
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        title: 'sessions.rebill.failed',
        description: 'sessions.rebill.notEligible.paid',
        variant: 'destructive',
      });
    });
  });

  it('hides the action without both permissions', () => {
    permissions.delete('payments:write');
    renderCard();
    expect(screen.getByTestId('session-rebill')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sessions\.rebill\.button/ })).toBeNull();
  });

  it('disables the action while the API says the session cannot be billed now', () => {
    renderCard({ rebillable: false, rebillBlockedReason: 'payment_pending' });
    expect(billButton().disabled).toBe(true);
    cleanup();
    renderCard({
      rebillStatus: 'in_progress',
      rebillable: false,
      rebillBlockedReason: 'in_progress',
    });
    expect(billButton().disabled).toBe(true);
    cleanup();
    renderCard({ rebillable: false, rebillBlockedReason: 'no_tariff' });
    expect(billButton().disabled).toBe(true);
  });

  it('enables the action again once a dead claim expired, with the re-bill record pending', () => {
    // The API reports rebillable for an expired claim and the re-bill's own
    // pending record, so the card does not second-guess it.
    renderCard({ rebillStatus: 'in_progress', rebillable: true, rebillBlockedReason: null });
    expect(billButton().disabled).toBe(false);
  });

  it('shows manual billing with the cost to collect, without the action', () => {
    renderCard({ status: 'completed', rebillStatus: 'manual', finalCostCents: 1190 });
    expect(screen.getByText('sessions.manualBilling')).toBeTruthy();
    expect(screen.getByText('sessions.rebill.manualHelp')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sessions\.rebill\.button/ })).toBeNull();
  });

  it('shows a session an operator billed', () => {
    renderCard({ status: 'completed', rebillStatus: 'billed', finalCostCents: 1190 });
    expect(screen.getByText('sessions.rebill.billedBadge')).toBeTruthy();
  });
});
