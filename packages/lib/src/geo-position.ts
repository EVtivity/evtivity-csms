// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The most characters of a stored coordinate (the station and unit columns). */
export const COORDINATE_MAX_LENGTH = 20;

const DECIMAL = /^-?\d{1,3}(\.\d{1,15})?$/;

export type PositionProblem = 'missing' | 'invalid' | 'out_of_range';

export type PositionResult =
  | { ok: true; value: { latitude: string; longitude: string } | null }
  | { ok: false; field: 'latitude' | 'longitude'; problem: PositionProblem };

function coordinateProblem(text: string, limit: number): PositionProblem | null {
  if (text.length > COORDINATE_MAX_LENGTH || !DECIMAL.test(text)) return 'invalid';
  const n = Number(text);
  return Math.abs(n) > limit ? 'out_of_range' : null;
}

/**
 * A position typed as two decimal-degree texts: both empty (or null) is no
 * position; one without the other is refused, and so is a value that is not a
 * plain decimal number or lies outside -90 to 90 (latitude) or -180 to 180
 * (longitude). The trimmed texts are kept as typed, the station storage form.
 */
export function parsePosition(
  latitude: string | null | undefined,
  longitude: string | null | undefined,
): PositionResult {
  const lat = latitude?.trim() ?? '';
  const lng = longitude?.trim() ?? '';
  if (lat === '' && lng === '') return { ok: true, value: null };
  if (lat === '') return { ok: false, field: 'latitude', problem: 'missing' };
  if (lng === '') return { ok: false, field: 'longitude', problem: 'missing' };
  const latProblem = coordinateProblem(lat, 90);
  if (latProblem != null) return { ok: false, field: 'latitude', problem: latProblem };
  const lngProblem = coordinateProblem(lng, 180);
  if (lngProblem != null) return { ok: false, field: 'longitude', problem: lngProblem };
  return { ok: true, value: { latitude: lat, longitude: lng } };
}

/** Great-circle distance in km between two points in decimal degrees. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
