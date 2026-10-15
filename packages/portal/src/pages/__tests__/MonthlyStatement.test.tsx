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
    t: (key: string, options?: { fleet?: string; count?: number }) =>
      options?.fleet != null
        ? `${key}:${options.fleet}`
        : options?.count != null
          ? `${key}:${String(options.count)}`
          : key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import { MonthlyStatement } from '../MonthlyStatement';

function row(id: string, accountBilling: Record<string, unknown> | null): Record<string, unknown> {
  return {
    id,
    startedAt: '2026-03-03T10:00:00Z',
    endedAt: '2026-03-03T11:00:00Z',
    energyDeliveredWh: '10000',
    finalCostCents: 900,
    taxCents: null,
    currency: 'EUR',
    siteName: 'Site A',
    siteCity: null,
    co2AvoidedKg: null,
    accountBilling,
  };
}

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/activity/statement?month=2026-03']}>
        <MonthlyStatement />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('MonthlyStatement', () => {
  it('lists a fleet-invoiced session as billed to the fleet and notes earlier-currency sessions', async () => {
    getMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('/v1/portal/sessions/monthly-statement')
          ? {
              month: '2026-03',
              driverName: 'Jane Doe',
              sessions: [
                row('card', null),
                row('fleet', {
                  state: 'unbilled',
                  fleetName: 'Acme',
                  invoicedTo: 'fleet',
                  invoiceId: null,
                  invoiceNumber: null,
                }),
              ],
              totals: {
                totalCostCents: 900,
                currency: 'EUR',
                totalEnergyWh: 20000,
                sessionCount: 2,
                totalCo2AvoidedKg: null,
                otherCurrencySessionCount: 2,
                fleetBilledSessionCount: 1,
              },
            }
          : { efficiencyMiPerKwh: 3.5 },
      ),
    );
    renderPage();

    expect(await screen.findByText('fleetBilling.billedTo:Acme')).toBeDefined();
    expect(screen.getByText('statement.otherCurrencyNote:2')).toBeDefined();
  });

  it('shows no currency note when every session is in the company currency', async () => {
    getMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('/v1/portal/sessions/monthly-statement')
          ? {
              month: '2026-03',
              driverName: 'Jane Doe',
              sessions: [row('card', null)],
              totals: {
                totalCostCents: 900,
                currency: 'EUR',
                totalEnergyWh: 10000,
                sessionCount: 1,
                totalCo2AvoidedKg: null,
                otherCurrencySessionCount: 0,
                fleetBilledSessionCount: 0,
              },
            }
          : { efficiencyMiPerKwh: 3.5 },
      ),
    );
    renderPage();

    expect(await screen.findByText('Jane Doe')).toBeDefined();
    expect(screen.queryByText(/statement\.otherCurrencyNote/)).toBeNull();
    expect(screen.queryByText(/fleetBilling\.billedTo/)).toBeNull();
  });
});
