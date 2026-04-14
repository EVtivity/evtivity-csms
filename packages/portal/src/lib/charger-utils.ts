// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { API_BASE_URL } from '@/lib/config';

export const CABLE_DETECTED_STATUSES = [
  'preparing',
  'ev_connected',
  'occupied',
  'charging',
  'suspended_ev',
  'suspended_evse',
];

export function isCableDetected(status: string | null): boolean {
  return status != null && CABLE_DETECTED_STATUSES.includes(status);
}

/** Add a space before trailing digits: "Type1" -> "Type 1", "CCS2" -> "CCS2" */
export function formatConnectorType(type: string): string {
  return type.replace(/^(Type)(\d)$/i, '$1 $2');
}

export async function checkGuestConnectorStatus(
  stationId: string,
  evseId: string,
): Promise<{ connectorStatus: string | null; error?: string }> {
  const response = await fetch(
    `${API_BASE_URL}/v1/portal/guest/check-status/${stationId}/${evseId}`,
    { method: 'POST' },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return {
      connectorStatus: null,
      error: body.error ?? 'Status check failed',
    };
  }

  return (await response.json()) as { connectorStatus: string | null; error?: string };
}
