// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The status a driver sees for one EVSE, from all of its connectors (an OCPP 2.x
// EVSE can hold several, such as CCS and CHAdeMO, of which one is used at a
// time). A connector in use wins, then a reservation, then an available
// connector; faulted or unavailable shows only when no connector can serve.

// Connector statuses of an EVSE in use, strongest first.
const IN_USE_ORDER = [
  'charging',
  'discharging',
  'suspended_ev',
  'suspended_evse',
  'idle',
  'occupied',
  'ev_connected',
  'preparing',
  'finishing',
] as const;

/** The EVSE status from its connector statuses (CSMS lowercase form). */
export function evseDisplayStatus(statuses: readonly (string | null | undefined)[]): string {
  const known = statuses.filter((s): s is string => s != null);
  for (const status of IN_USE_ORDER) {
    if (known.includes(status)) return status;
  }
  if (known.includes('reserved')) return 'reserved';
  if (known.includes('available')) return 'available';
  if (known.includes('faulted')) return 'faulted';
  return known.includes('unavailable') || known.length === 0
    ? 'unavailable'
    : (known[0] ?? 'unavailable');
}
