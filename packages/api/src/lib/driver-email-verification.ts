// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, isNull } from 'drizzle-orm';
import { db, client, userTokens } from '@evtivity/database';
import { dispatchSystemNotification } from '@evtivity/lib';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { generateUserToken } from './user-token.js';
import { config } from './config.js';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface VerificationRecipient {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  language: string;
}

/**
 * Issues a new email verification link for the driver and emails it: revokes
 * the open verification links, stores a hashed 24-hour token and sends
 * driver.AccountVerification to the email address only (the link verifies the
 * address; the phone is unverified). Used by portal registration, the resend
 * route and the operator email change. The dispatch is not awaited and fails
 * open with a log (P9).
 */
export async function sendDriverEmailVerification(
  driver: VerificationRecipient,
  log: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  await db
    .update(userTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(userTokens.driverId, driver.id),
        eq(userTokens.type, 'email_verification'),
        isNull(userTokens.revokedAt),
      ),
    );

  const { raw, hash } = generateUserToken();
  await db.insert(userTokens).values({
    driverId: driver.id,
    tokenHash: hash,
    type: 'email_verification',
    expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
  });

  void dispatchSystemNotification(
    client,
    'driver.AccountVerification',
    { email: driver.email, firstName: driver.firstName, language: driver.language },
    {
      firstName: driver.firstName,
      lastName: driver.lastName,
      email: driver.email,
      verifyUrl: `${config.PORTAL_URL}/verify-email?token=${raw}`,
    },
    ALL_TEMPLATES_DIRS,
  ).catch((err: unknown) => {
    log.warn({ err, driverId: driver.id }, 'Email verification dispatch failed');
  });
}
