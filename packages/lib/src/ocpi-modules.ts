// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPI modules the OCPI server can pull from a partner's sender endpoint on an
// `ocpi_sync` request. The API validates the manual sync route against this list
// (it cannot import @evtivity/ocpi); the OCPI module registry must match it.
export const OCPI_PULL_MODULES = ['locations', 'tariffs', 'cdrs'] as const;

export type OcpiPullModule = (typeof OCPI_PULL_MODULES)[number];

// Settings every published OCPI tariff is rendered with: the currency, whether
// tariff prices include tax, and the idle grace (published as min_duration).
// A change to one pushes every published tariff again (the API) and moves
// their last_updated (the OCPI server).
export const OCPI_TARIFF_SETTING_KEYS = [
  'company.currency',
  'company.taxBasis',
  'idling.gracePeriodMinutes',
] as const;
