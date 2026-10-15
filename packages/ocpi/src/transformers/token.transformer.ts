// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { ocpiTokenTypeOf as sharedOcpiTokenTypeOf } from '@evtivity/lib';
import type { OcpiToken, OcpiTokenType, OcpiVersion } from '../types/ocpi.js';

/**
 * A driver token as the eMSP serves it, or a tombstone: a token value that no
 * longer exists (deleted, or its value or type changed). OCPI cannot delete a
 * Token (12.1.1), so a tombstone is served as valid = false, with
 * last_updated = the time it stopped existing.
 */
export interface EmspTokenRow {
  idToken: string;
  tokenType: string;
  isActive: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  updatedAt: Date;
  tombstone: boolean;
}

interface TokenTransformInput {
  token: EmspTokenRow;
  countryCode: string;
  partyId: string;
  driverName?: string;
}

/** The OCPI Token type of a driver token type (the `type` URL parameter of a push). */
export function ocpiTokenTypeOf(tokenType: string): OcpiTokenType {
  return sharedOcpiTokenTypeOf(tokenType);
}

export function transformToken(input: TokenTransformInput, version: OcpiVersion): OcpiToken {
  const { token, countryCode, partyId } = input;

  // Mirror the same usability check the OCPP authorize handlers apply: a
  // card is only `valid` while active, not revoked, and not expired. Without
  // this, revoked or expired cards round-trip to partners as valid and
  // partners then attempt to authorize charging that the CSMS rejects at
  // the OCPP layer — drivers see an inconsistent experience.
  const now = Date.now();
  const valid =
    !token.tombstone &&
    token.isActive &&
    token.revokedAt == null &&
    (token.expiresAt == null || token.expiresAt.getTime() > now);

  const result: OcpiToken = {
    country_code: countryCode,
    party_id: partyId,
    uid: token.idToken,
    type: ocpiTokenTypeOf(token.tokenType),
    contract_id: token.idToken,
    issuer: partyId,
    valid,
    whitelist: 'ALLOWED',
    last_updated: token.updatedAt.toISOString(),
  };

  if (version === '2.3.0') {
    // 2.3.0-specific token fields will be added here
  }

  return result;
}
