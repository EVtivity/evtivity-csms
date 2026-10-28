// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen, fireEvent } from '@testing-library/react';
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
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import { Activity } from '../Activity';

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

function session(id: string): Record<string, unknown> {
  return {
    id,
    status: 'completed',
    siteName: `Site ${id}`,
    stationName: null,
    siteCity: null,
    energyDeliveredWh: 1000,
    finalCostCents: 100,
    taxCents: 0,
    currency: 'EUR',
    startedAt: '2026-10-01T10:00:00Z',
    endedAt: '2026-10-01T11:00:00Z',
  };
}

function mockApi(total: number): void {
  getMock.mockImplementation((path: string) =>
    Promise.resolve(
      path.startsWith('/v1/portal/sessions?')
        ? { data: [session(path.includes('page=2') ? 'b' : 'a')], total }
        : path.startsWith('/v1/portal/sessions/monthly-summary')
          ? {
              totalCostCents: 0,
              totalEnergyWh: 0,
              sessionCount: 0,
              currency: 'EUR',
              totalCo2AvoidedKg: 0,
            }
          : { efficiencyMiPerKwh: 3.5 },
    ),
  );
}

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Activity />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function listCalls(): string[] {
  return getMock.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.startsWith('/v1/portal/sessions?'));
}

describe('Activity', () => {
  it('pages the session list by page number from 1, never by offset', async () => {
    mockApi(0);
    renderPage();
    await waitFor(() => {
      expect(listCalls().length).toBeGreaterThan(0);
    });
    expect(listCalls()[0]).toMatch(/[?&]page=1(&|$)/);
    expect(listCalls()[0]).not.toContain('offset=');
    // One page: no page controls.
    expect(screen.queryByText('common.next')).toBeNull();
  });

  it('shows one page at a time with Prev and Next', async () => {
    mockApi(15);
    renderPage();
    expect(await screen.findByText('Site a')).toBeTruthy();
    expect(screen.getByText('common.pageOf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /common\.next/ }));
    expect(await screen.findByText('Site b')).toBeTruthy();
    expect(screen.queryByText('Site a')).toBeNull();
    expect(listCalls().some((path) => /[?&]page=2(&|$)/.test(path))).toBe(true);
  });
});
