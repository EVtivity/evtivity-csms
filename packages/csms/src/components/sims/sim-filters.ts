// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The SIM list filters kept in the URL, in the query parameter names of
 * `GET /v1/sims` and `GET /v1/sims/export`. `status` is the CSMS status
 * (Deactivate, Reactivate) and `state` the provider status of the last
 * Refresh: two separate filters.
 */
export const SIM_FILTER_KEYS = ['provider', 'attachment', 'status', 'state', 'stationId'] as const;

export type SimFilterKey = (typeof SIM_FILTER_KEYS)[number];

export type SimFilters = Partial<Record<SimFilterKey, string>>;

export const SIM_ATTACHMENT_FILTERS = ['attached', 'unattached', 'unconfirmed'] as const;

export const SIM_CSMS_STATUSES = ['active', 'inactive'] as const;

/** The provider states a Refresh stores, in the order the filter lists them. */
export const SIM_PROVIDER_STATES = [
  'active',
  'pending',
  'suspended',
  'inactive',
  'deactivated',
  'test',
  'unknown',
] as const;

/** The filters set in the URL, without empty or unknown parameters. */
export function simListParams(searchParams: URLSearchParams): SimFilters {
  const filters: SimFilters = {};
  for (const key of SIM_FILTER_KEYS) {
    const value = searchParams.get(key) ?? '';
    if (value !== '') filters[key] = value;
  }
  return filters;
}

/** The query string of Export CSV: the search and the filters on screen. */
export function simExportQuery(search: string, filters: SimFilters): string {
  const params = new URLSearchParams();
  if (search !== '') params.set('search', search);
  for (const key of SIM_FILTER_KEYS) {
    const value = filters[key];
    if (value != null && value !== '') params.set(key, value);
  }
  return params.toString();
}
