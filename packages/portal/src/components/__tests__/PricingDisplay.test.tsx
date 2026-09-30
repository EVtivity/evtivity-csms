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
    render(<PricingDisplay pricing={pricing} />);
    // Testing Library normalizes the non-breaking space before the symbol.
    expect(screen.getByText('0,49 €/charger.unitKwh')).toBeDefined();
  });

  it('shows prices in English format for English', async () => {
    await i18next.changeLanguage('en');
    render(<PricingDisplay pricing={pricing} />);
    expect(screen.getByText('€0.49/charger.unitKwh')).toBeDefined();
  });
});
