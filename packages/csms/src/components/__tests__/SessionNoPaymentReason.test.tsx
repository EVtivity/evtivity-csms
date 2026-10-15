// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const perms = vi.hoisted(() => ({ settings: true, invoices: true }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'fleet' in opts ? `${key}:${String(opts['fleet'])}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (perm: string) => (perm === 'settings.payment:read' ? perms.settings : true),
  useHasCompanyWidePermission: () => perms.invoices,
}));
vi.mock('@/lib/api', () => ({ api: { post: vi.fn() } }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import {
  SessionNoPaymentReason,
  type NoPaymentReason,
  type NoPaymentReasonContext,
} from '../session/SessionNoPaymentReason';
import { SessionPaymentTab } from '../session/SessionPaymentTab';

function renderReason(props: NoPaymentReasonContext): void {
  render(
    <MemoryRouter>
      <SessionNoPaymentReason {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  perms.settings = true;
  perms.invoices = true;
});

const PLAIN_REASONS: NoPaymentReason[] = [
  'free_vend',
  'roaming',
  'account_credit_limit',
  'anonymous',
  'no_payment_method',
  'payment_failed',
  'pending',
  'no_cost',
  'prepaid_not_debited',
  'not_held',
];

describe('SessionNoPaymentReason', () => {
  it.each(PLAIN_REASONS)('explains %s with its sentence and no action', (reason) => {
    renderReason({ reason });
    expect(screen.getByText(`sessions.noPaymentReason.${reason}`)).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('payments off links to the payment settings for a user who can read them', () => {
    renderReason({ reason: 'payments_off' });
    expect(screen.getByText('sessions.noPaymentReason.payments_off')).toBeDefined();
    const link = screen.getByRole('link', { name: 'sessions.noPaymentReason.openPaymentSettings' });
    expect(link.getAttribute('href')).toBe('/settings?tab=payment');
  });

  it('payments off shows no settings link without the permission', () => {
    perms.settings = false;
    renderReason({ reason: 'payments_off' });
    expect(screen.getByText('sessions.noPaymentReason.payments_off')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('account billed names the fleet and links to the invoice', () => {
    renderReason({ reason: 'account_billed', fleetName: 'Acme', invoiceId: 'inv_1' });
    expect(screen.getByText('sessions.noPaymentReason.account_billed:Acme')).toBeDefined();
    const link = screen.getByRole('link', { name: 'sessions.noPaymentReason.viewInvoice' });
    expect(link.getAttribute('href')).toBe('/invoices/inv_1');
  });

  it('account billed to the member, not invoiced yet, has no invoice link', () => {
    renderReason({ reason: 'account_billed', fleetName: 'Acme', memberBilled: true });
    expect(screen.getByText('sessions.noPaymentReason.account_billed_member:Acme')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('account billed hides the invoice link without company-wide payments access', () => {
    perms.invoices = false;
    renderReason({ reason: 'account_billed', fleetName: 'Acme', invoiceId: 'inv_1' });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('guest opens the Guest Session tab', () => {
    const open = vi.fn();
    renderReason({ reason: 'guest', onOpenGuestTab: open });
    expect(screen.getByText('sessions.noPaymentReason.guest')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'sessions.noPaymentReason.openGuestTab' }));
    expect(open).toHaveBeenCalledOnce();
  });
});

describe('SessionPaymentTab without a payment record', () => {
  function renderTab(noPaymentReason: NoPaymentReasonContext | null): void {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SessionPaymentTab
            sessionId="ses_1"
            payment={null}
            canRefund={false}
            formatCents={(cents) => String(cents)}
            timezone="UTC"
            noPaymentReason={noPaymentReason}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('shows the reason under the empty state', () => {
    renderTab({ reason: 'payments_off' });
    expect(screen.getByText('sessions.noPayment')).toBeDefined();
    expect(screen.getByTestId('no-payment-reason')).toBeDefined();
    expect(screen.getByText('sessions.noPaymentReason.payments_off')).toBeDefined();
  });

  it('shows only the empty state without a reason', () => {
    renderTab(null);
    expect(screen.getByText('sessions.noPayment')).toBeDefined();
    expect(screen.queryByTestId('no-payment-reason')).toBeNull();
  });
});
