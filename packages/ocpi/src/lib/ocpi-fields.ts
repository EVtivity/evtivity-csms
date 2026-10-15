// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Field checks for data partners send us (receivers and pulls). Values that
// do not fit OCPI's field definitions are refused with 2001 instead of
// reaching the database, where an over-long id failed the insert (500) and a
// malformed coordinate broke the portal roaming search.

/** OCPI GeoLocation.latitude: `-?[0-9]{1,2}\.[0-9]{5,7}` (OCPI 2.3.0 8.4.16). */
export const OCPI_LATITUDE_PATTERN = /^-?[0-9]{1,2}\.[0-9]{5,7}$/;
/** OCPI GeoLocation.longitude: `-?[0-9]{1,3}\.[0-9]{5,7}` (OCPI 2.3.0 8.4.16). */
export const OCPI_LONGITUDE_PATTERN = /^-?[0-9]{1,3}\.[0-9]{5,7}$/;

/** Maximum lengths of the identifiers in module URLs and objects. */
export const OCPI_FIELD_MAX: Readonly<Record<string, number>> = {
  country_code: 2,
  party_id: 3,
  location_id: 36,
  evse_uid: 36,
  connector_id: 36,
  session_id: 36,
  tariff_id: 36,
  token_uid: 36,
  cdr_id: 36,
};

/** A non-empty string of at most `max` characters (OCPI CiString(n) / string(n)). */
export function fitsOcpiString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** True when `coords` is a GeoLocation whose values match the OCPI patterns and ranges. */
export function isOcpiGeoLocation(
  coords: unknown,
): coords is { latitude: string; longitude: string } {
  if (coords == null || typeof coords !== 'object') return false;
  const { latitude, longitude } = coords as { latitude?: unknown; longitude?: unknown };
  if (typeof latitude !== 'string' || typeof longitude !== 'string') return false;
  if (!OCPI_LATITUDE_PATTERN.test(latitude) || !OCPI_LONGITUDE_PATTERN.test(longitude)) {
    return false;
  }
  return Math.abs(Number(latitude)) <= 90 && Math.abs(Number(longitude)) <= 180;
}

/**
 * The first URL parameter longer than its OCPI field allows, or null. Unknown
 * parameter names are not checked.
 */
export function overlongParam(params: unknown): string | null {
  if (params == null || typeof params !== 'object') return null;
  for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
    const max = OCPI_FIELD_MAX[name];
    if (max == null) continue;
    if (!fitsOcpiString(value, max)) return name;
  }
  return null;
}

/**
 * The first identity field of a PUT body that differs from the URL, or null.
 * OCPI: the object in the body is the object the URL names.
 */
export function bodyIdentityMismatch(
  body: Record<string, unknown>,
  expected: Readonly<Record<string, string>>,
): string | null {
  for (const [field, value] of Object.entries(expected)) {
    if (body[field] !== value) return field;
  }
  return null;
}

/**
 * The first identity field a PATCH body tries to change, or null. A PATCH
 * updates the object the URL names; it cannot rename it or move it to another
 * party. A field equal to the stored or URL value is allowed.
 */
export function patchChangesIdentity(
  patch: Record<string, unknown>,
  current: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    if (!(field in patch)) continue;
    if (patch[field] !== current[field]) return field;
  }
  return null;
}
