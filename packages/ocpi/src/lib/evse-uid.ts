// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The OCPI EVSE uid is the EVSE's internal id (`evs_` + 12 characters), unique
// across the CPO and within OCPI's 36-character limit. An EVSE number alone
// repeats across the stations of a site.
export function ocpiEvseUid(evse: { id: string }): string {
  return evse.id;
}

// The human-readable OCPI evse_id: `{stationId}-EVSE-{number}`.
export function ocpiEvseId(stationOcppId: string, evseNumber: number): string {
  return `${stationOcppId}-EVSE-${String(evseNumber)}`;
}
