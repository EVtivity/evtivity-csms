// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * OCPP 2.1 IdTokenEnumStringType (Appendices): the token types a driver token
 * can have. One list for the API validation, the CSMS forms and the portal, so
 * a form never offers a type the API refuses. Browser-safe.
 */
export const OCPP_ID_TOKEN_TYPES = [
  'Central',
  'DirectPayment',
  'eMAID',
  'EVCCID',
  'ISO14443',
  'ISO15693',
  'KeyCode',
  'Local',
  'MacAddress',
  'NoAuthorization',
  'VIN',
] as const;

export type OcppIdTokenType = (typeof OCPP_ID_TOKEN_TYPES)[number];

/** Types a driver cannot register from the portal or the mobile app. */
const NOT_PORTAL_ID_TOKEN_TYPES = [
  // Not something a driver holds: a CSMS-issued id, a system marker, and a
  // payment terminal reference never looked up on Authorize.
  'Central',
  'NoAuthorization',
  'DirectPayment',
  // Vehicle ids: a card with another car's VIN, EVCCID or MAC address would
  // take over its Autocharge starts (a card wins over a vehicle on
  // Authorize). They enter only through the vehicle service and the session
  // vehicle id claim; operators keep every type.
  'VIN',
  'EVCCID',
  'MacAddress',
] as const;

/** Types a driver registers from the portal or the mobile app. */
export const PORTAL_ID_TOKEN_TYPES = OCPP_ID_TOKEN_TYPES.filter(
  (t) => !(NOT_PORTAL_ID_TOKEN_TYPES as readonly string[]).includes(t),
) as readonly Exclude<OcppIdTokenType, (typeof NOT_PORTAL_ID_TOKEN_TYPES)[number]>[];

export type PortalIdTokenType = (typeof PORTAL_ID_TOKEN_TYPES)[number];

export function isOcppIdTokenType(value: string): value is OcppIdTokenType {
  return (OCPP_ID_TOKEN_TYPES as readonly string[]).includes(value);
}

/** The status a token shows, matching the authorize decision: inactive or revoked first, then expiry. */
export type DriverTokenStatus = 'active' | 'inactive' | 'revoked' | 'expired';

export function driverTokenStatus(
  token: {
    isActive: boolean;
    revokedAt?: string | Date | null | undefined;
    expiresAt?: string | Date | null | undefined;
  },
  now: number = Date.now(),
): DriverTokenStatus {
  if (!token.isActive) return token.revokedAt != null ? 'revoked' : 'inactive';
  if (token.revokedAt != null) return 'revoked';
  if (token.expiresAt != null && new Date(token.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}
