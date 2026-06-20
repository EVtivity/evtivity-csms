// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPP 1.6: available, preparing, finishing. OCPP 2.1: available, occupied, ev_connected.
// Mirrored by `packages/api/src/routes/portal/charger.ts` and
// `packages/api/src/routes/portal/guest.ts`; backend rejects with
// `CONNECTOR_NOT_AVAILABLE` for anything outside this set.
export const STARTABLE_STATUSES = [
  'available',
  'occupied',
  'preparing',
  'ev_connected',
  'finishing',
];

export function isStartable(status: string | null | undefined): boolean {
  return status != null && STARTABLE_STATUSES.includes(status);
}

export interface SelectableEvse {
  connectors: { status: string | null }[];
  reservationDriverId: string | null;
}

// Whether the driver can act on an EVSE in the current mode. Charge mode: online,
// a startable connector, and not reserved by another driver (a reservation flips
// the connector to a startable status the moment the holder plugs in, so without
// the reserved-by-other gate any driver could start against the holder's plug).
// Reserve mode: online and not already reserved.
export function isEvseSelectable(
  evse: SelectableEvse,
  opts: {
    mode: 'charge' | 'reserve';
    isOnline: boolean;
    maintenanceActive: boolean;
    currentDriverId: string | null;
  },
): boolean {
  if (opts.maintenanceActive || !opts.isOnline) return false;
  if (opts.mode === 'reserve') return evse.reservationDriverId == null;
  const connectorStatus = evse.connectors[0]?.status ?? 'unavailable';
  const reservedByOther =
    evse.reservationDriverId != null && evse.reservationDriverId !== opts.currentDriverId;
  const reservedForMe =
    evse.reservationDriverId != null && evse.reservationDriverId === opts.currentDriverId;
  return !reservedByOther && (isStartable(connectorStatus) || reservedForMe);
}

export function connectorStatusVariant(): 'secondary' {
  return 'secondary';
}

export function connectorStatusClassName(status: string): string {
  switch (status) {
    case 'available':
      return 'bg-green-500 text-green-50 hover:bg-green-500/80';
    case 'finishing':
      return 'bg-violet-500 text-violet-50 hover:bg-violet-500/80';
    case 'occupied':
    case 'charging':
    case 'discharging':
      return 'bg-blue-500 text-blue-50 hover:bg-blue-500/80';
    case 'preparing':
    case 'ev_connected':
      return 'bg-cyan-500 text-cyan-50 hover:bg-cyan-500/80';
    case 'reserved':
      return 'bg-orange-500 text-orange-50 hover:bg-orange-500/80';
    case 'suspended_ev':
    case 'suspended_evse':
    case 'idle':
      return 'bg-yellow-500 text-yellow-50 hover:bg-yellow-500/80';
    case 'faulted':
    case 'unavailable':
    default:
      return 'bg-red-500 text-red-50 hover:bg-red-500/80';
  }
}
