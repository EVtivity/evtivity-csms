// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from 'node:crypto';
import { db, driverTokens } from '@evtivity/database';
import { createId } from '@evtivity/database/src/lib/id.js';
import type { TestTokens } from './types.js';

/** Token type of every provisioned test token (the 1.6 handlers look idTags up as ISO14443). */
export const TEST_TOKEN_TYPE = 'ISO14443';

/** Prefix of every provisioned test token. */
export const TEST_TOKEN_PREFIX = 'OCTT';

/**
 * Generates a fresh token set for one test. Each value is 16 characters
 * (prefix + 10 hex + role), within the 1.6 idTag CiString20 limit.
 */
export function generateTestTokens(): TestTokens {
  const id = randomBytes(5).toString('hex').toUpperCase();
  const token = (role: string): string => `${TEST_TOKEN_PREFIX}${id}${role}`;
  return {
    valid: token('V1'),
    valid2: token('V2'),
    masterpass: token('MP'),
    blocked: token('BL'),
    expired: token('EX'),
    prepaid: token('PP'),
    noCredit: token('NC'),
    emaid: token('EM'),
  };
}

/** Prepaid credit of the prepaid token (cents of the company currency). */
export const TEST_PREPAID_BALANCE_CENTS = 5000;

/**
 * Inserts the token set for the OCTT test driver. The blocked token is
 * inactive; the expired token is active with an expiry date in the past, so
 * the CSMS answers Expired (not Blocked). The prepaid token has credit and the
 * noCredit token is prepaid with a zero balance, so the CSMS answers NoCredit.
 * Rows are removed with the test driver at run end.
 */
export async function provisionTestTokens(driverId: string, tokens: TestTokens): Promise<void> {
  const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const row = (
    idToken: string,
    extra: {
      isActive?: boolean;
      expiresAt?: Date;
      tokenType?: string;
      prepaidBalanceCents?: number;
    } = {},
  ) => ({
    id: createId('driverToken'),
    driverId,
    idToken,
    tokenType: extra.tokenType ?? TEST_TOKEN_TYPE,
    isActive: extra.isActive ?? true,
    ...(extra.expiresAt != null ? { expiresAt: extra.expiresAt } : {}),
    ...(extra.prepaidBalanceCents != null
      ? { prepaidBalanceCents: extra.prepaidBalanceCents }
      : {}),
  });
  await db
    .insert(driverTokens)
    .values([
      row(tokens.valid),
      row(tokens.valid2),
      row(tokens.masterpass),
      row(tokens.blocked, { isActive: false }),
      row(tokens.expired, { expiresAt: expiredAt }),
      row(tokens.prepaid, { prepaidBalanceCents: TEST_PREPAID_BALANCE_CENTS }),
      row(tokens.noCredit, { prepaidBalanceCents: 0 }),
      row(tokens.emaid, { tokenType: 'eMAID' }),
    ])
    .onConflictDoNothing();
}
