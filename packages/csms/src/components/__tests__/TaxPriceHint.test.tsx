// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { price?: string }) => `${key}:${options?.price ?? ''}`,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/hooks/use-company-currency', () => ({
  useCompanyCurrency: () => ({ currency: 'EUR', isError: false, refetch: vi.fn() }),
}));

const taxBasis = vi.hoisted((): { value: 'net' | 'gross' | undefined } => ({ value: 'net' }));
vi.mock('@/hooks/use-company-tax-basis', () => ({
  useCompanyTaxBasis: () => taxBasis.value,
}));

import { TaxPriceHint } from '../pricing/TaxPriceHint';

describe('TaxPriceHint', () => {
  beforeEach(() => {
    taxBasis.value = 'net';
  });

  it('shows the gross price of a net price in the company currency', () => {
    const { container } = render(<TaxPriceHint price="0.2152" taxRate="0.19" />);
    expect(container.textContent).toBe('pricing.grossPriceHint:€0.2561');
  });

  it('shows the net price of a gross price under the gross tax basis', () => {
    taxBasis.value = 'gross';
    const { container } = render(<TaxPriceHint price="0.357" taxRate="0.19" />);
    expect(container.textContent).toBe('pricing.netPriceHint:€0.30');
  });

  it('renders nothing without a tax rate or price, or before the tax basis loads', () => {
    expect(render(<TaxPriceHint price="0.25" taxRate="" />).container.textContent).toBe('');
    expect(render(<TaxPriceHint price="" taxRate="0.19" />).container.textContent).toBe('');
    taxBasis.value = undefined;
    expect(render(<TaxPriceHint price="0.25" taxRate="0.19" />).container.textContent).toBe('');
  });
});
