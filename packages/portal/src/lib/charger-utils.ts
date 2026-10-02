// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { ApiError } from '@/lib/api';
import { API_BASE_URL } from '@/lib/config';

export const CABLE_DETECTED_STATUSES = [
  'preparing',
  'ev_connected',
  'occupied',
  'charging',
  'suspended_ev',
  'suspended_evse',
  // OCPP 1.6 post-stop state: cable still plugged in. Equivalent to 'occupied' on 2.1.
  'finishing',
];

export function isCableDetected(status: string | null): boolean {
  return status != null && CABLE_DETECTED_STATUSES.includes(status);
}

export interface QrTransactionLimits {
  maxEnergyWh?: number;
  maxTimeSeconds?: number;
  maxCostCents?: number;
}

function positiveNumber(value: string | null): number | null {
  if (value == null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Reads the limits a charging station adds to its QR code URL (OCPP 2.1
 * C25.FR.04-06): maxenergy in Wh, maxtime in seconds, and maxcost in the
 * currency of the station (major units). Invalid or missing values are left out.
 */
export function qrTransactionLimits(params: URLSearchParams): QrTransactionLimits {
  const maxEnergy = positiveNumber(params.get('maxenergy'));
  const maxTime = positiveNumber(params.get('maxtime'));
  const maxCost = positiveNumber(params.get('maxcost'));
  return {
    ...(maxEnergy != null ? { maxEnergyWh: Math.round(maxEnergy) } : {}),
    ...(maxTime != null ? { maxTimeSeconds: Math.round(maxTime) } : {}),
    ...(maxCost != null ? { maxCostCents: Math.round(maxCost * 100) } : {}),
  };
}

/** Add a space before trailing digits: "Type1" -> "Type 1", "CCS2" -> "CCS2" */
export function formatConnectorType(type: string): string {
  return type.replace(/^(Type)(\d)$/i, '$1 $2');
}

export async function checkGuestConnectorStatus(
  stationId: string,
  evseId: string,
): Promise<{ connectorStatus: string }> {
  const response = await fetch(
    `${API_BASE_URL}/v1/portal/guest/check-status/${stationId}/${evseId}`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new ApiError(response.status, await response.json().catch(() => null));
  }
  return (await response.json()) as { connectorStatus: string };
}
