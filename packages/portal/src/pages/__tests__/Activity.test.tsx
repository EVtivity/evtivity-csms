// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
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

beforeAll(() => {
  // jsdom has no IntersectionObserver; the page observes its list sentinel.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('Activity', () => {
  it('pages the session list by page number from 1, never by offset', async () => {
    getMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('/v1/portal/sessions?')
          ? { data: [], total: 0 }
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
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Activity />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(
        getMock.mock.calls.some(([path]) => String(path).startsWith('/v1/portal/sessions?')),
      ).toBe(true);
    });
    const listCall = getMock.mock.calls
      .map(([path]) => String(path))
      .find((path) => path.startsWith('/v1/portal/sessions?'));
    expect(listCall).toMatch(/[?&]page=1(&|$)/);
    expect(listCall).not.toContain('offset=');
  });
});
