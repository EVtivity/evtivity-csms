// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The station fields a BootNotification reports and the CSMS then keeps read-only. */
export type ReportedStationField = 'model' | 'serialNumber';

export interface ReportedStationIdentity {
  model: string | null;
  serialNumber: string | null;
  modelReportedAt: Date | string | null;
  serialNumberReportedAt: Date | string | null;
}

/**
 * The first field a write would change although the station reported it at
 * its boot, or null. The same value passes, so a form that sends the stored
 * value back is not refused. Before the first boot both fields stay editable,
 * and a station that booted without a serial number keeps that one editable.
 */
export function reportedFieldChange(
  stored: ReportedStationIdentity,
  next: { model?: string | null | undefined; serialNumber?: string | null | undefined },
): ReportedStationField | null {
  if (
    stored.modelReportedAt != null &&
    next.model !== undefined &&
    (next.model ?? null) !== stored.model
  ) {
    return 'model';
  }
  if (
    stored.serialNumberReportedAt != null &&
    next.serialNumber !== undefined &&
    (next.serialNumber ?? null) !== stored.serialNumber
  ) {
    return 'serialNumber';
  }
  return null;
}
