// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';

vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([
      {
        id: 'trf_000000000001',
        pricingGroupId: 'pgr_000000000001',
        name: 'Standard',
        pricePerKwh: '0.49',
        pricePerMinute: null,
        pricePerSession: '1.5',
        isActive: true,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: '0.19',
        restrictions: null,
        priority: 0,
        isDefault: true,
        createdAt: '2026-09-30T00:00:00Z',
      },
    ]),
  },
}));

import { PricingGroupTariffsTab } from '../pricing/PricingGroupTariffsTab';

function renderTab(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PricingGroupTariffsTab groupId="pgr_000000000001" />
    </QueryClientProvider>,
  );
}

describe('PricingGroupTariffsTab', () => {
  beforeAll(async () => {
    await i18next.init({ lng: 'en', resources: {} });
  });

  afterEach(async () => {
    cleanup();
    await i18next.changeLanguage('en');
  });

  it('shows stored prices with the decimal separator of the UI language', async () => {
    await i18next.changeLanguage('de');
    renderTab();
    expect(await screen.findByText('0,49')).toBeDefined();
    expect(screen.getByText('1,5')).toBeDefined();
    expect(screen.getByText('0,19')).toBeDefined();
  });

  it('keeps "." for English', async () => {
    await i18next.changeLanguage('en');
    renderTab();
    expect(await screen.findByText('0.49')).toBeDefined();
  });
});
