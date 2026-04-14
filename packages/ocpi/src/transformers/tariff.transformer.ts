// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type {
  OcpiTariff,
  OcpiTariffElement,
  OcpiPriceComponent,
  OcpiVersion,
} from '../types/ocpi.js';

interface TariffRow {
  id: string;
  name: string;
  currency: string;
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  taxRate: string | null;
  isActive: boolean;
  updatedAt: Date;
}

interface TariffTransformInput {
  tariff: TariffRow;
  countryCode: string;
  partyId: string;
  ocpiTariffId: string;
}

function parseDecimal(value: string | null): number | null {
  if (value == null) return null;
  const parsed = parseFloat(value);
  if (isNaN(parsed)) return null;
  return parsed;
}

export function transformTariff(input: TariffTransformInput, version: OcpiVersion): OcpiTariff {
  const { tariff, countryCode, partyId, ocpiTariffId } = input;

  const taxRate = parseDecimal(tariff.taxRate);
  const pricePerKwh = parseDecimal(tariff.pricePerKwh);
  const pricePerMinute = parseDecimal(tariff.pricePerMinute);
  const pricePerSession = parseDecimal(tariff.pricePerSession);
  const idleFee = parseDecimal(tariff.idleFeePricePerMinute);

  const priceComponents: OcpiPriceComponent[] = [];

  if (pricePerKwh != null && pricePerKwh > 0) {
    const component: OcpiPriceComponent = {
      type: 'ENERGY',
      price: pricePerKwh,
      step_size: 1,
    };
    if (taxRate != null) {
      component.vat = taxRate;
    }
    priceComponents.push(component);
  }

  if (pricePerMinute != null && pricePerMinute > 0) {
    const component: OcpiPriceComponent = {
      type: 'TIME',
      price: pricePerMinute,
      step_size: 60,
    };
    if (taxRate != null) {
      component.vat = taxRate;
    }
    priceComponents.push(component);
  }

  if (pricePerSession != null && pricePerSession > 0) {
    const component: OcpiPriceComponent = {
      type: 'FLAT',
      price: pricePerSession,
      step_size: 1,
    };
    if (taxRate != null) {
      component.vat = taxRate;
    }
    priceComponents.push(component);
  }

  // If no price components defined, add a zero-cost energy component
  if (priceComponents.length === 0) {
    priceComponents.push({
      type: 'ENERGY',
      price: 0,
      step_size: 1,
    });
  }

  const elements: OcpiTariffElement[] = [{ price_components: priceComponents }];

  // Idle fee as a separate element with parking_time restriction
  if (idleFee != null && idleFee > 0) {
    const idleComponent: OcpiPriceComponent = {
      type: 'PARKING_TIME',
      price: idleFee,
      step_size: 60,
    };
    if (taxRate != null) {
      idleComponent.vat = taxRate;
    }
    elements.push({ price_components: [idleComponent] });
  }

  const result: OcpiTariff = {
    country_code: countryCode,
    party_id: partyId,
    id: ocpiTariffId,
    currency: tariff.currency,
    type: 'REGULAR',
    elements,
    last_updated: tariff.updatedAt.toISOString(),
  };

  if (version === '2.3.0') {
    // 2.3.0-specific tariff fields (NA tax, open enums) will be added here
  }

  return result;
}
