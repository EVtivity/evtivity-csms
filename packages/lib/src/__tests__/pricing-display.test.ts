// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { formatPricingDisplay } from '../pricing-display.js';
import type { TariffInput } from '../cost-calculator.js';

describe('formatPricingDisplay', () => {
  const fullTariff: TariffInput = {
    pricePerKwh: '0.25',
    pricePerMinute: '0.05',
    pricePerSession: '1.00',
    idleFeePricePerMinute: '0.50',
    reservationFeePerMinute: null,
    taxRate: '0.08',
    currency: 'USD',
  };

  describe('standard format', () => {
    it('displays all pricing components', () => {
      const result = formatPricingDisplay(fullTariff, 'standard', 'USD');
      expect(result).toBe(
        'Energy: $0.25/kWh | Time: $0.05/min | Session: $1.00 | Idle: $0.50/min | Tax: 8%',
      );
    });

    it('omits zero-value components', () => {
      const tariff: TariffInput = {
        pricePerKwh: '0.30',
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
        currency: 'USD',
      };
      const result = formatPricingDisplay(tariff, 'standard', 'USD');
      expect(result).toBe('Energy: $0.30/kWh');
    });

    it('returns Free for all-zero tariff', () => {
      const tariff: TariffInput = {
        pricePerKwh: null,
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
        currency: 'USD',
      };
      const result = formatPricingDisplay(tariff, 'standard', 'USD');
      expect(result).toBe('Free');
    });
  });

  describe('compact format', () => {
    it('displays all pricing components', () => {
      const result = formatPricingDisplay(fullTariff, 'compact', 'USD');
      expect(result).toBe('$0.25/kWh + $0.05/min + $1.00 session + $0.50/min idle');
    });

    it('omits zero-value components', () => {
      const tariff: TariffInput = {
        pricePerKwh: '0.30',
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
        currency: 'USD',
      };
      const result = formatPricingDisplay(tariff, 'compact', 'USD');
      expect(result).toBe('$0.30/kWh');
    });

    it('returns Free for all-zero tariff', () => {
      const tariff: TariffInput = {
        pricePerKwh: null,
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
        currency: 'USD',
      };
      const result = formatPricingDisplay(tariff, 'compact', 'USD');
      expect(result).toBe('Free');
    });
  });

  describe('currency symbols', () => {
    it('uses EUR symbol', () => {
      const tariff: TariffInput = {
        pricePerKwh: '0.30',
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
        currency: 'EUR',
      };
      const result = formatPricingDisplay(tariff, 'compact', 'EUR');
      expect(result).toBe('\u20AC0.30/kWh');
    });

    it('uses GBP symbol', () => {
      const tariff: TariffInput = {
        pricePerKwh: '0.30',
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
        currency: 'GBP',
      };
      const result = formatPricingDisplay(tariff, 'compact', 'GBP');
      expect(result).toBe('\u00A30.30/kWh');
    });

    it('uses currency code for unknown currencies', () => {
      const tariff: TariffInput = {
        pricePerKwh: '0.30',
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
        currency: 'JPY',
      };
      const result = formatPricingDisplay(tariff, 'compact', 'JPY');
      expect(result).toBe('JPY 0.30/kWh');
    });
  });
});
