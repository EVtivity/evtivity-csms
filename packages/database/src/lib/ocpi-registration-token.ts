// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPI registration tokens (CREDENTIALS_TOKEN_A, OCPI 2.3.0 7.1). The one
// writer for the API (partner create, a new token for a partner that has not
// registered yet) and the seed. Each token is bound to its partner: the OCPI
// server accepts it only on versions, version details and credentials, and
// only for a registration whose roles carry that partner's country code and
// party id.

import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import type { db as defaultDb } from '../config.js';
import { ocpiCredentialsTokens } from '../schema/ocpi.js';

type TokenDb = Pick<typeof defaultDb, 'insert' | 'update'>;

/**
 * Retires the partner's open registration tokens and stores a new one, bound
 * to the partner. Returns the plaintext token: shown once, never stored.
 */
export async function issueOcpiRegistrationToken(
  partnerId: string,
  database: TokenDb,
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = await argon2.hash(token);

  await database
    .update(ocpiCredentialsTokens)
    .set({ isActive: false })
    .where(
      and(
        eq(ocpiCredentialsTokens.partnerId, partnerId),
        eq(ocpiCredentialsTokens.direction, 'issued'),
        eq(ocpiCredentialsTokens.kind, 'registration'),
        eq(ocpiCredentialsTokens.isActive, true),
      ),
    );
  await database.insert(ocpiCredentialsTokens).values({
    partnerId,
    tokenHash,
    tokenPrefix: token.slice(0, 8),
    direction: 'issued',
    kind: 'registration',
    isActive: true,
  });
  return token;
}
