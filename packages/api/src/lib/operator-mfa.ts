// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { readMfaConfig } from '@evtivity/database';
import { sendSignInMfaCode } from './sign-in-backoff.js';
import { hasMfa, mfaSignInFactors, type MfaFactor } from './mfa-factors.js';
import { mfaFactorCounts } from '../services/mfa-factor.service.js';
import {
  requiredMfaEnrollment,
  type OperatorMfaEnrollment,
  type MfaPolicyUnavailable,
  type MfaSetupUnavailable,
} from './mfa-enrollment.js';

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
  /** The session version the enrollment JWT carries (the current one). */
  sessionVersion: number;
}

/** What the caller hands back instead of a session: the input of POST /v1/auth/mfa/verify. */
export interface OperatorMfaPending {
  mfaRequired: true;
  mfaMethod: string;
  mfaToken: string;
  challengeId: number | undefined;
  /** The factors the challenge may use: the method while it is usable, recovery codes while any are left, and passkeys. */
  factors: MfaFactor[];
  /** Set when an admin switched the method off and another factor remains: no code was sent. */
  mfaMethodDisabled?: true;
}

/**
 * The operator MFA gate. Every path that issues an operator session (password
 * login, forced password change, SSO) calls it first: for a user with MFA it
 * signs the 3-minute MFA pending JWT, creates and sends the email or SMS code,
 * and returns the pending state, so no session is issued until
 * POST /v1/auth/mfa/verify accepts the code. A user without MFA whom required
 * MFA covers gets the enrollment reply instead of a session, or the setup
 * unavailable reply (the caller refuses the sign-in) when no method can be
 * set up, or the policy unavailable reply when no MFA settings could be read.
 * Null when the user signs in without MFA. A method switched off in Settings > Security >
 * MFA is handled by mfaSignInFactors.
 */
export async function beginOperatorMfa(
  app: FastifyInstance,
  user: OperatorMfaUser,
): Promise<
  OperatorMfaPending | OperatorMfaEnrollment | MfaSetupUnavailable | MfaPolicyUnavailable | null
> {
  const counts = await mfaFactorCounts({ userId: user.id });
  if (!hasMfa({ ...user, ...counts })) return requiredMfaEnrollment(app, user);

  // The pending token carries the session version, so a password change or sign-out between
  // the password step and the second factor ends it.
  const mfaToken = app.jwt.sign(
    { userId: user.id, roleId: user.roleId, mfaPending: true, sv: user.sessionVersion },
    { expiresIn: '3m' },
  );

  // A method an admin switched off gets no code while the account has another factor:
  // POST /v1/auth/mfa/verify refuses it with MFA_METHOD_DISABLED.
  const { gate, factors, methodDisabled } = mfaSignInFactors(
    { ...user, ...counts },
    await readMfaConfig(),
  );

  let challengeId: number | undefined;
  if (
    gate !== 'refused' &&
    user.mfaEnabled &&
    (user.mfaMethod === 'email' || user.mfaMethod === 'sms')
  ) {
    challengeId = await sendSignInMfaCode({ userId: user.id }, user.mfaMethod, user, TEMPLATES_DIR);
  }

  return {
    mfaRequired: true,
    // An account whose only factor is a passkey or security key has no primary method.
    mfaMethod: user.mfaEnabled && user.mfaMethod != null ? user.mfaMethod : 'passkey',
    mfaToken,
    challengeId,
    factors,
    ...(methodDisabled ? { mfaMethodDisabled: true as const } : {}),
  };
}
