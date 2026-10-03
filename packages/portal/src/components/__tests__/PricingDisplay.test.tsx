// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import i18next from 'i18next';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { PricingDisplay, type PricingInfo } from '../PricingDisplay';

const pricing: PricingInfo = {
  currency: 'EUR',
  pricePerKwh: '0.49',
  pricePerMinute: null,
  pricePerSession: '1.50',
  idleFeePricePerMinute: null,
  taxRate: '0.19',
};

describe('PricingDisplay', () => {
  beforeAll(async () => {
    await i18next.init({ lng: 'en', resources: {} });
  });

  afterEach(async () => {
    cleanup();
    await i18next.changeLanguage('en');
  });

  it('shows prices with the separators and symbol position of German', async () => {
    await i18next.changeLanguage('de');
    render(<PricingDisplay pricing={pricing} priceDisplay="net" />);
    // Testing Library normalizes the non-breaking space before the symbol.
    expect(screen.getByText('0,49 €/charger.unitKwh')).toBeDefined();
  });

  it('shows prices in English format for English', async () => {
    await i18next.changeLanguage('en');
    render(<PricingDisplay pricing={pricing} priceDisplay="net" />);
    expect(screen.getByText('€0.49/charger.unitKwh')).toBeDefined();
  });

  it('adds the tax rate to every price for gross display', async () => {
    await i18next.changeLanguage('en');
    render(<PricingDisplay pricing={{ ...pricing, pricePerKwh: '0.2152' }} priceDisplay="gross" />);
    expect(screen.getByText('€0.2561/charger.unitKwh')).toBeDefined();
    expect(screen.getByText('charger.taxIncluded')).toBeDefined();
  });

  it('shows net prices and says that tax is added for net display', async () => {
    await i18next.changeLanguage('en');
    render(<PricingDisplay pricing={{ ...pricing, pricePerKwh: '0.2152' }} priceDisplay="net" />);
    expect(screen.getByText('€0.2152/charger.unitKwh')).toBeDefined();
    expect(screen.getByText('charger.taxExcluded')).toBeDefined();
  });

  it('shows gross-basis prices as entered for gross display', async () => {
    await i18next.changeLanguage('en');
    render(
      <PricingDisplay
        pricing={{ ...pricing, pricePerKwh: '0.357', taxBasis: 'gross' }}
        priceDisplay="gross"
      />,
    );
    expect(screen.getByText('€0.357/charger.unitKwh')).toBeDefined();
    expect(screen.getByText('charger.taxIncluded')).toBeDefined();
  });

  it('takes the tax out of gross-basis prices for net display', async () => {
    await i18next.changeLanguage('en');
    render(
      <PricingDisplay
        pricing={{ ...pricing, pricePerKwh: '0.357', taxBasis: 'gross' }}
        priceDisplay="net"
      />,
    );
    expect(screen.getByText('€0.30/charger.unitKwh')).toBeDefined();
    expect(screen.getByText('charger.taxExcluded')).toBeDefined();
  });

  it('shows a session fee as money rounded to the cent, as it is billed', async () => {
    await i18next.changeLanguage('en');
    render(
      <PricingDisplay
        pricing={{
          ...pricing,
          currency: 'USD',
          pricePerKwh: null,
          pricePerSession: '0.50',
          taxRate: '0.0825',
        }}
        priceDisplay="gross"
      />,
    );
    // 0.50 plus 8.25% tax is 0.54125: a rate would show $0.5413, a fee shows $0.54.
    expect(screen.getByText('$0.54')).toBeDefined();
  });

  it('shows no tax note without a tax rate', async () => {
    await i18next.changeLanguage('en');
    render(<PricingDisplay pricing={{ ...pricing, taxRate: null }} priceDisplay="gross" />);
    expect(screen.getByText('€0.49/charger.unitKwh')).toBeDefined();
    expect(screen.queryByText('charger.taxIncluded')).toBeNull();
  });
});
