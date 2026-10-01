// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Basic Auth password rules for charging stations (security profiles 1 and 2).
 * Browser-safe, so the CSMS imports it via `@evtivity/lib/station-password`.
 *
 * OCPP 2.1 (A00.FR.205): a passwordString of 16 to 40 characters (a station's
 * maxLimit is at least 40). OCPP 1.6 (Security Whitepaper, OCTT TC_073): the
 * AuthorizationKey is 16 to 20 bytes, sent hex-encoded. The charset is ASCII,
 * so characters equal bytes.
 */

export type StationOcppProtocol = 'ocpp1.6' | 'ocpp2.1';

export const STATION_PASSWORD_CHARSET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*-_=:+|@.';

export type StationPasswordError = 'tooShort' | 'tooLong' | 'invalidCharacters';

const PASSWORD_PATTERN = /^[a-zA-Z0-9*\-_=:+|@.]*$/;

export function stationPasswordRules(protocol: StationOcppProtocol): { min: number; max: number } {
  return protocol === 'ocpp1.6' ? { min: 16, max: 20 } : { min: 16, max: 40 };
}

export function validateStationPassword(
  password: string,
  protocol: StationOcppProtocol,
): StationPasswordError | null {
  if (!PASSWORD_PATTERN.test(password)) {
    return 'invalidCharacters';
  }
  const { min, max } = stationPasswordRules(protocol);
  if (password.length < min) return 'tooShort';
  if (password.length > max) return 'tooLong';
  return null;
}

// Letters and digits only, so a generated password is easy to read and type.
const GENERATED_CHARSET = STATION_PASSWORD_CHARSET.slice(0, 62);
const GENERATED_LENGTH = 20;

/** A random 20-character password, valid for OCPP 1.6 and 2.1. */
export function generateStationPassword(): string {
  const bytes = new Uint8Array(GENERATED_LENGTH * 2);
  let out = '';
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % GENERATED_CHARSET.length);
  while (out.length < GENERATED_LENGTH) {
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit) out += GENERATED_CHARSET.charAt(b % GENERATED_CHARSET.length);
      if (out.length === GENERATED_LENGTH) break;
    }
  }
  return out;
}

/** The OCPP 1.6 AuthorizationKey value: the password bytes as uppercase hex. */
export function toAuthorizationKeyHex(password: string): string {
  return [...new TextEncoder().encode(password)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}
