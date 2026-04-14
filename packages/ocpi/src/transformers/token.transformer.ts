// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcpiToken, OcpiTokenType, OcpiVersion } from '../types/ocpi.js';

interface DriverTokenRow {
  id: string;
  idToken: string;
  tokenType: string;
  isActive: boolean;
  updatedAt: Date;
}

interface TokenTransformInput {
  token: DriverTokenRow;
  countryCode: string;
  partyId: string;
  driverName?: string;
}

const TOKEN_TYPE_MAP: Record<string, OcpiTokenType> = {
  ISO14443: 'RFID',
  ISO15693: 'RFID',
  eMAID: 'APP_USER',
  Central: 'OTHER',
  Local: 'OTHER',
  MacAddress: 'OTHER',
  NoAuthorization: 'AD_HOC_USER',
  KeyCode: 'OTHER',
};

function mapTokenType(tokenType: string): OcpiTokenType {
  return TOKEN_TYPE_MAP[tokenType] ?? 'RFID';
}

export function transformToken(input: TokenTransformInput, version: OcpiVersion): OcpiToken {
  const { token, countryCode, partyId } = input;

  const result: OcpiToken = {
    country_code: countryCode,
    party_id: partyId,
    uid: token.idToken,
    type: mapTokenType(token.tokenType),
    contract_id: token.idToken,
    issuer: partyId,
    valid: token.isActive,
    whitelist: 'ALLOWED',
    last_updated: token.updatedAt.toISOString(),
  };

  if (version === '2.3.0') {
    // 2.3.0-specific token fields will be added here
  }

  return result;
}
