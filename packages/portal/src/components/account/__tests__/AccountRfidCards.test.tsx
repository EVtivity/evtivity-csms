// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { get: getMock, post: vi.fn(), patch: vi.fn() }, ApiError };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { AccountRfidCards } from '../AccountRfidCards';

function card(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'dtk_1',
    idToken: 'CARD0001',
    tokenType: 'ISO14443',
    isActive: true,
    expiresAt: null,
    blockedByOperator: false,
    ...over,
  };
}

function renderCards(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountRfidCards />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('AccountRfidCards', () => {
  it('locks a card the operator deactivated and says why', async () => {
    getMock.mockResolvedValue([card({ isActive: false, blockedByOperator: true })]);
    renderCards();

    expect(await screen.findByText('rfid.blockedByOperator')).toBeTruthy();
    const toggle = screen.getByRole('switch');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });

  it('lets the driver turn on a card the driver removed', async () => {
    getMock.mockResolvedValue([card({ isActive: false, blockedByOperator: false })]);
    renderCards();

    const toggle = await screen.findByRole('switch');
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('rfid.blockedByOperator')).toBeNull();
  });

  it('marks an active card past its expiry as expired', async () => {
    getMock.mockResolvedValue([card({ expiresAt: '2020-01-01T00:00:00Z' })]);
    renderCards();

    expect(await screen.findByText('rfid.expired')).toBeTruthy();
  });
});
