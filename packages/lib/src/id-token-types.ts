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

/**
 * Types a driver registers from the portal or the mobile app. Central (a
 * CSMS-issued id), NoAuthorization (a system marker) and DirectPayment (a
 * payment terminal reference, never looked up on Authorize) are not something
 * a driver holds.
 */
export const DRIVER_ID_TOKEN_TYPES = OCPP_ID_TOKEN_TYPES.filter(
  (t) => t !== 'Central' && t !== 'NoAuthorization' && t !== 'DirectPayment',
) as readonly Exclude<OcppIdTokenType, 'Central' | 'NoAuthorization' | 'DirectPayment'>[];

export type DriverIdTokenType = (typeof DRIVER_ID_TOKEN_TYPES)[number];

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
