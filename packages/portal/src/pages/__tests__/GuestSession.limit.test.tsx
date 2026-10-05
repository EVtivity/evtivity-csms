// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: vi.fn() } };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));

vi.mock('@/components/SessionCharts', () => ({ SessionCharts: () => null }));

import { GuestSession } from '../GuestSession';

function status(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    status: 'charging',
    stationOcppId: 'CS-1',
    evseId: 1,
    isSimulator: true,
    energyDeliveredWh: 54,
    currentCostCents: 55,
    finalCostCents: null,
    taxCents: 4,
    currency: 'USD',
    startedAt: new Date().toISOString(),
    endedAt: null,
    idleStartedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderSession(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/guest-session/tok1']}>
        <Routes>
          <Route path="/guest-session/:sessionToken" element={<GuestSession />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('GuestSession limit reason', () => {
  it('tells the guest the hold amount was reached', async () => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/status/') ? status({ limitReached: 'cost' }) : { data: [] }),
    );
    renderSession();
    expect(await screen.findByText('sessionDetail.limitReached.cost')).toBeTruthy();
  });

  it('shows no reason without a reached limit', async () => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/status/') ? status({ limitReached: null }) : { data: [] }),
    );
    renderSession();
    expect(await screen.findByText('sessionDetail.idle')).toBeTruthy();
    expect(screen.queryByText(/sessionDetail\.limitReached/)).toBeNull();
  });
});
