// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { client } from '@evtivity/database';
import { createMfaChallenge, dispatchSystemNotification } from '@evtivity/lib';

const currentDir = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = process.env['API_TEMPLATES_DIR'] ?? resolve(currentDir, '..', 'templates');

/** The user fields the operator MFA gate reads. */
export interface OperatorMfaUser {
  id: string;
  roleId: string;
  email: string;
  phone: string | null;
  firstName: string | null;
  language: string;
  mfaEnabled: boolean;
  mfaMethod: string | null;
}

/** What the caller hands back instead of a session: the input of POST /v1/auth/mfa/verify. */
export interface OperatorMfaPending {
  mfaRequired: true;
  mfaMethod: string;
  mfaToken: string;
  challengeId: number | undefined;
}

/**
 * The operator MFA gate. Every path that issues an operator session (password
 * login, forced password change, SSO) calls it first: for a user with MFA it
 * signs the 3-minute MFA pending JWT, creates and sends the email or SMS code,
 * and returns the pending state, so no session is issued until
 * POST /v1/auth/mfa/verify accepts the code. Null when the user has no MFA.
 */
export async function beginOperatorMfa(
  app: FastifyInstance,
  user: OperatorMfaUser,
): Promise<OperatorMfaPending | null> {
  if (!user.mfaEnabled || user.mfaMethod == null) return null;

  const mfaToken = app.jwt.sign(
    { userId: user.id, roleId: user.roleId, mfaPending: true },
    { expiresIn: '3m' },
  );

  let challengeId: number | undefined;
  if (user.mfaMethod === 'email' || user.mfaMethod === 'sms') {
    const challenge = await createMfaChallenge(client, {
      userId: user.id,
      method: user.mfaMethod,
    });
    challengeId = challenge.challengeId;
    await dispatchSystemNotification(
      client,
      'mfa.VerificationCode',
      {
        email: user.email,
        phone: user.phone ?? undefined,
        firstName: user.firstName ?? undefined,
        language: user.language,
      },
      { code: challenge.code },
      TEMPLATES_DIR,
    );
  }

  return { mfaRequired: true, mfaMethod: user.mfaMethod, mfaToken, challengeId };
}
