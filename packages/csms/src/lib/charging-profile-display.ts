// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The OCPP profile id of a stored charging profile row, which a station uses
 * to identify the profile when clearing. The row's own `id` is the database
 * key. profile_data holds `id` (2.1) or `chargingProfileId` (a profile set in
 * 1.6 form). A station-reported row holds the array of profiles of one report
 * and names one profile only when the array has one element. Returns null when
 * no single id applies.
 */
export function ocppProfileId(profile: { profileData: unknown }): number | null {
  const data = profile.profileData;
  const single: unknown = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data;
  if (single == null || typeof single !== 'object') return null;
  const record = single as Record<string, unknown>;
  const raw = record['id'] ?? record['chargingProfileId'];
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Number(raw);
  return null;
}

/**
 * Start time of a GetCompositeSchedule answer: `schedule.scheduleStart` in
 * OCPP 2.1 (the OCPP server returns a 1.6 answer in the same shape). Null when
 * the station sent none, so the dialog shows offsets instead of inventing one.
 */
export function compositeScheduleAnchor(response: {
  schedule?: { scheduleStart?: string | undefined } | undefined;
}): string | null {
  const start = response.schedule?.scheduleStart;
  return typeof start === 'string' && start !== '' ? start : null;
}
