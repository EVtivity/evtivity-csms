// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The OCPI Token type of a driver token type. OCPI identifies a Token by its
// uid and OCPI type (12.4.2), so two driver token types with the same OCPI
// type (ISO14443 and ISO15693 are both RFID) are one OCPI Token. The API
// (token tombstones) and the OCPI server (Tokens sender and push) share this
// map, so both decide the same.

export type OcpiTokenTypeName = 'AD_HOC_USER' | 'APP_USER' | 'OTHER' | 'RFID';

export const OCPI_TOKEN_TYPE_BY_DRIVER_TYPE: Readonly<Record<string, OcpiTokenTypeName>> = {
  ISO14443: 'RFID',
  ISO15693: 'RFID',
  eMAID: 'APP_USER',
  Central: 'OTHER',
  Local: 'OTHER',
  MacAddress: 'OTHER',
  EVCCID: 'OTHER',
  VIN: 'OTHER',
  DirectPayment: 'AD_HOC_USER',
  NoAuthorization: 'AD_HOC_USER',
  KeyCode: 'OTHER',
};

/** The OCPI Token type of a driver token type (RFID for an unknown type). */
export function ocpiTokenTypeOf(tokenType: string): OcpiTokenTypeName {
  return OCPI_TOKEN_TYPE_BY_DRIVER_TYPE[tokenType] ?? 'RFID';
}

/**
 * Whether a token change from one value and type to another is a new OCPI
 * Token (the old one must be invalidated at partners): a changed uid or a
 * changed OCPI type. ISO14443 to ISO15693 is the same OCPI Token.
 */
export function isNewOcpiToken(
  before: { idToken: string; tokenType: string },
  after: { idToken: string; tokenType: string },
): boolean {
  return (
    before.idToken !== after.idToken ||
    ocpiTokenTypeOf(before.tokenType) !== ocpiTokenTypeOf(after.tokenType)
  );
}
