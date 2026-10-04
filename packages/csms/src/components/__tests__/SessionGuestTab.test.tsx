// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));

import { SessionGuestTab } from '../session/SessionGuestTab';

const guest = {
  sessionToken: 'guesttoken0000000001',
  guestEmail: 'guest@example.com',
  status: 'completed',
  preAuthAmountCents: 2000,
  provider: 'stripe' as string | null,
  providerPaymentId: 'pi_guest_1' as string | null,
  expiresAt: '2026-01-02T10:00:00.000Z',
  createdAt: '2026-01-01T10:00:00.000Z',
};

function renderTab(overrides: Partial<typeof guest> = {}): HTMLElement {
  const { container } = render(
    <SessionGuestTab
      guest={{ ...guest, ...overrides }}
      currency="USD"
      timezone="UTC"
      formatCents={(cents) => String(cents)}
    />,
  );
  return container;
}

afterEach(() => {
  cleanup();
});

describe('SessionGuestTab', () => {
  it('shows the provider payment id of the guest charge', () => {
    renderTab();
    expect(screen.getByText('pi_guest_1')).toBeDefined();
    expect(screen.getByText('sessions.guestProviderPayment')).toBeDefined();
  });

  it('shows the provider name as a badge', () => {
    renderTab({ provider: 'simulated' });
    expect(screen.getByText('sessions.guestPaymentProvider')).toBeDefined();
    expect(screen.getByText('paymentProviders.names.simulated')).toBeDefined();
  });

  it('shows a plugin provider id as is', () => {
    renderTab({ provider: 'acme' });
    expect(screen.getByText('acme')).toBeDefined();
  });

  it('shows a dash when the guest charge has no provider payment id', () => {
    const container = renderTab({ provider: null, providerPaymentId: null });
    expect(container.textContent).not.toContain('pi_guest_1');
    expect(container.textContent).toContain('-');
  });
});
