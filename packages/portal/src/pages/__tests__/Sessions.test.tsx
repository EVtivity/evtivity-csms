// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { get: getMock },
  ApiError: class ApiError extends Error {},
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: { amount?: string }) =>
      options?.amount != null ? `${key}:${options.amount}` : key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import { Sessions } from '../Sessions';

function session(
  id: string,
  finalCostCents: number | null,
  tariffTaxRate: string | null,
): Record<string, unknown> {
  return {
    id,
    transactionId: `tx-${id}`,
    status: finalCostCents == null ? 'active' : 'completed',
    startedAt: '2026-01-01T10:00:00Z',
    endedAt: finalCostCents == null ? null : '2026-01-01T11:00:00Z',
    energyDeliveredWh: '10000',
    finalCostCents,
    tariffTaxRate,
    currency: 'EUR',
    stationName: `CS-${id}`,
    siteName: null,
  };
}

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Sessions />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('Sessions', () => {
  it('labels a taxed amount as including tax, through the interpolated key', async () => {
    getMock.mockResolvedValue({ data: [session('1', 1190, '0.19')], total: 1 });
    renderPage();
    expect(await screen.findByText('common.amountInclTax:€11.90')).toBeDefined();
  });

  it('shows an untaxed amount without the label', async () => {
    getMock.mockResolvedValue({ data: [session('2', 1000, null)], total: 1 });
    renderPage();
    expect(await screen.findByText('€10.00')).toBeDefined();
    expect(screen.queryByText(/common\.amountInclTax/)).toBeNull();
  });

  it('shows no label for an active session without a final cost', async () => {
    getMock.mockResolvedValue({ data: [session('3', null, '0.19')], total: 1 });
    renderPage();
    expect(await screen.findByText('CS-3')).toBeDefined();
    expect(screen.queryByText(/common\.amountInclTax/)).toBeNull();
    expect(screen.queryByText(/incl/)).toBeNull();
  });
});
