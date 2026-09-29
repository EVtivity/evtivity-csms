// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcpiTariff } from '../types/ocpi.js';

/**
 * A stored OCPI tariff with its currency set to the one the platform bills in.
 * Mapping data can hold a stale currency from before single-currency.
 */
export function tariffInCurrency(ocpiTariffData: unknown, currency: string): OcpiTariff {
  return { ...(ocpiTariffData as OcpiTariff), currency };
}
