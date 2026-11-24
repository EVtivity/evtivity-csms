// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));

import {
  TariffCurrentLimitField,
  TariffCurrentLimitNotEnforced,
  TariffCurrentLimitText,
  tariffCurrentLimitBody,
  tariffCurrentLimitError,
} from '../TariffCurrentLimitField';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('tariffCurrentLimitError', () => {
  it('accepts an empty field (no limit) and 6 to 500 A with one decimal', () => {
    for (const value of ['', '  ', '6', '16', '32.5', '500']) {
      expect(tariffCurrentLimitError(value)).toBeNull();
    }
  });

  it('refuses values below 6 A, above 500 A, with two decimals or not a number', () => {
    for (const value of ['5', '5.9', '500.1', '16.25', 'abc', '-10']) {
      expect(tariffCurrentLimitError(value)).toBe('pricing.maxCurrentRange');
    }
  });
});

describe('tariffCurrentLimitBody', () => {
  it('sends the number, null for an empty field and null on a DC tariff', () => {
    expect(tariffCurrentLimitBody('16', 'ac')).toBe(16);
    expect(tariffCurrentLimitBody('32.5', 'both')).toBe(32.5);
    expect(tariffCurrentLimitBody('', 'ac')).toBeNull();
    expect(tariffCurrentLimitBody('16', 'dc')).toBeNull();
  });
});

describe('TariffCurrentLimitField', () => {
  it('hides the field on a DC tariff', () => {
    render(
      <TariffCurrentLimitField
        value="16"
        onChange={() => undefined}
        chargingType="dc"
        idPrefix="t"
        showError={false}
      />,
    );
    expect(screen.queryByLabelText('pricing.maxCurrent')).toBeNull();
  });

  it('says the limit applies to AC sessions only on a Both tariff', () => {
    render(
      <TariffCurrentLimitField
        value=""
        onChange={() => undefined}
        chargingType="both"
        idPrefix="t"
        showError={false}
      />,
    );
    expect(screen.getByLabelText('pricing.maxCurrent')).toBeTruthy();
    expect(screen.getByText(/pricing\.maxCurrentAcOnly/)).toBeTruthy();
  });

  it('leaves the AC only sentence out on an AC tariff', () => {
    render(
      <TariffCurrentLimitField
        value=""
        onChange={() => undefined}
        chargingType="ac"
        idPrefix="t"
        showError={false}
      />,
    );
    expect(screen.getByText('pricing.maxCurrentHint')).toBeTruthy();
    expect(screen.queryByText(/pricing\.maxCurrentAcOnly/)).toBeNull();
  });

  it('shows the range error only after a submit', () => {
    const { rerender } = render(
      <TariffCurrentLimitField
        value="5"
        onChange={() => undefined}
        chargingType="ac"
        idPrefix="t"
        showError={false}
      />,
    );
    expect(screen.queryByText('pricing.maxCurrentRange')).toBeNull();
    rerender(
      <TariffCurrentLimitField
        value="5"
        onChange={() => undefined}
        chargingType="ac"
        idPrefix="t"
        showError
      />,
    );
    expect(screen.getByText('pricing.maxCurrentRange')).toBeTruthy();
  });
});

describe('TariffCurrentLimitText', () => {
  it('shows the amps or No limit', () => {
    const { rerender } = render(<TariffCurrentLimitText value={16} />);
    expect(screen.getByText(/pricing\.maxCurrentValue.*"amps":"16"/)).toBeTruthy();
    rerender(<TariffCurrentLimitText value={null} />);
    expect(screen.getByText('pricing.maxCurrentNone')).toBeTruthy();
  });
});

describe('TariffCurrentLimitNotEnforced', () => {
  it('shows nothing without sites', () => {
    wrap(<TariffCurrentLimitNotEnforced siteIds={[]} />);
    expect(screen.queryByTestId('tariff-limit-not-enforced')).toBeNull();
  });

  it('names the sites whose load management is off', async () => {
    getMock.mockResolvedValue({
      data: [
        { id: 'sit_a', name: 'North Lot' },
        { id: 'sit_b', name: 'Depot' },
      ],
    });
    wrap(<TariffCurrentLimitNotEnforced siteIds={['sit_a', 'sit_b']} />);
    const alert = await screen.findByTestId('tariff-limit-not-enforced');
    await waitFor(() => {
      expect(alert.textContent).toContain('North Lot, Depot');
    });
    expect(alert.textContent).toContain('pricing.maxCurrentNotEnforced');
  });
});
