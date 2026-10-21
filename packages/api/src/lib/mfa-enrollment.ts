// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, readMfaConfig, roles, users, type MfaConfig } from '@evtivity/database';
import { isMfaRequiredForRole } from '@evtivity/lib/mfa-config';
import { hasMfaContact } from './mfa-contact.js';
import { usableFactors } from './mfa-factors.js';
import { getUserSessionState } from './user-active.js';
import { selfService } from '../middleware/rbac.js';
import { mfaFactorCounts } from '../services/mfa-factor.service.js';

/** How long an operator has to set up MFA after the password or SSO step. */
export const MFA_ENROLLMENT_TOKEN_TTL = '10m';

export const MFA_SETUP_METHODS = ['email', 'totp', 'sms'] as const;
export type MfaSetupMethod = (typeof MFA_SETUP_METHODS)[number];

/** The sign-in reply instead of a session: the user must set up MFA first. */
export interface OperatorMfaEnrollment {
  mfaEnrollmentRequired: true;
  enrollmentToken: string;
  availableMethods: MfaSetupMethod[];
  /** A passkey or security key can be the enrolled factor (POST /v1/users/me/webauthn/registration). */
  webauthnAvailable: boolean;
}

/** The user fields the enrollment step reads. */
export interface MfaEnrollmentUser {
  id: string;
  roleId: string;
  email: string | null;
  phone: string | null;
  sessionVersion: number;
}

/** The methods the account can set up now: switched on, and with the contact the code goes to. */
export function availableMfaMethods(
  config: Pick<MfaConfig, 'emailEnabled' | 'totpEnabled' | 'smsEnabled'>,
  contact: { email: string | null; phone: string | null },
): MfaSetupMethod[] {
  const methods: MfaSetupMethod[] = [];
  if (config.emailEnabled && hasMfaContact('email', contact)) methods.push('email');
  if (config.totpEnabled) methods.push('totp');
  if (config.smsEnabled && hasMfaContact('sms', contact)) methods.push('sms');
  return methods;
}

/**
 * The 10-minute enrollment JWT. It carries the session version, so the
 * session the confirm step issues (which raises the version) ends it.
 */
export function signMfaEnrollmentToken(app: FastifyInstance, user: MfaEnrollmentUser): string {
  return app.jwt.sign(
    { userId: user.id, roleId: user.roleId, mfaEnrollment: true, sv: user.sessionVersion },
    { expiresIn: MFA_ENROLLMENT_TOKEN_TTL },
  );
}

/**
 * The enrollment reply for a user who must set up MFA, or null when no method
 * can be set up (every switch off, or SMS only without a phone): the user then
 * signs in without MFA rather than being locked out.
 */
export function operatorMfaEnrollment(
  app: FastifyInstance,
  user: MfaEnrollmentUser,
  config: MfaConfig,
): OperatorMfaEnrollment | null {
  const availableMethods = availableMfaMethods(config, user);
  if (availableMethods.length === 0) {
    app.log.warn(
      { userId: user.id },
      'MFA setup is needed but no method can be set up, signing in without it',
    );
    return null;
  }
  return {
    mfaEnrollmentRequired: true,
    enrollmentToken: signMfaEnrollmentToken(app, user),
    availableMethods,
    webauthnAvailable: config.webauthnEnabled,
  };
}

async function roleName(roleId: string): Promise<string | null> {
  const [role] = await db.select({ name: roles.name }).from(roles).where(eq(roles.id, roleId));
  return role?.name ?? null;
}

/** The sign-in reply when required MFA covers the user but no method can be set up. */
export interface MfaSetupUnavailable {
  mfaSetupUnavailable: true;
}

/** The sign-in reply when the MFA settings could not be read, so required MFA cannot be decided. */
export interface MfaPolicyUnavailable {
  mfaPolicyUnavailable: true;
}

/** Whether required MFA (Settings > Security > MFA) covers the role. */
async function mfaRequiredForRole(config: MfaConfig, roleId: string): Promise<boolean> {
  if (config.required === 'off') return false;
  return isMfaRequiredForRole(config, await roleName(roleId));
}

/** What required MFA decides for a role, or `unavailable` when no settings could be read. */
export type MfaPolicyDecision = 'required' | 'not_required' | 'unavailable';

/**
 * Whether required MFA covers the user's role. A failed settings read with
 * nothing cached answers `unavailable`, and every caller then refuses (fail closed).
 */
export async function mfaPolicyForRole(roleId: string): Promise<MfaPolicyDecision> {
  const reading = await readMfaConfig();
  if (reading.fallback) return 'unavailable';
  return (await mfaRequiredForRole(reading.config, roleId)) ? 'required' : 'not_required';
}

/** Logs the refusal at error and answers 503 MFA_POLICY_UNAVAILABLE. */
export async function sendMfaPolicyUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<void> {
  request.log.error(
    { userId },
    'The MFA settings could not be read, so required MFA refuses the request',
  );
  await reply.status(503).send({
    error: 'The MFA policy could not be read. Try again later.',
    code: 'MFA_POLICY_UNAVAILABLE',
  });
}

/**
 * Required MFA (Settings > Security > MFA) for a user without MFA: the
 * enrollment reply when the setting covers the user's role, else null. When
 * no method can be set up (every switch off, or SMS only without a phone),
 * the sign-in is refused instead of signing in without MFA. A failed
 * settings read with nothing cached refuses the sign-in too (fail closed).
 */
export async function requiredMfaEnrollment(
  app: FastifyInstance,
  user: MfaEnrollmentUser,
): Promise<OperatorMfaEnrollment | MfaSetupUnavailable | MfaPolicyUnavailable | null> {
  const reading = await readMfaConfig();
  if (reading.fallback) {
    app.log.error(
      { userId: user.id },
      'The MFA settings could not be read, so required MFA refuses the sign-in',
    );
    return { mfaPolicyUnavailable: true };
  }
  if (!(await mfaRequiredForRole(reading.config, user.roleId))) return null;
  const availableMethods = availableMfaMethods(reading.config, user);
  if (availableMethods.length === 0) {
    app.log.error(
      { userId: user.id },
      'Required MFA covers the user but no method can be set up, sign-in refused',
    );
    return { mfaSetupUnavailable: true };
  }
  return {
    mfaEnrollmentRequired: true,
    enrollmentToken: signMfaEnrollmentToken(app, user),
    availableMethods,
    webauthnAvailable: reading.config.webauthnEnabled,
  };
}

/** Whether a sign-in gate reply refuses the sign-in because no MFA method can be set up. */
export function isMfaSetupUnavailable(reply: object): reply is MfaSetupUnavailable {
  return 'mfaSetupUnavailable' in reply;
}

/** Whether a sign-in gate reply refuses the sign-in because the MFA settings could not be read. */
export function isMfaPolicyUnavailable(reply: object): reply is MfaPolicyUnavailable {
  return 'mfaPolicyUnavailable' in reply;
}

/** What a session renewal does under required MFA. */
export type RenewalMfaGate = 'renew' | 'enrollment_required' | 'policy_unavailable';

/**
 * Required MFA at a session renewal: a user with a usable factor (the method,
 * recovery codes or a passkey, as at sign-in) renews; a user without one whom
 * required MFA covers signs in again and enrolls; when no settings can be
 * read, a user without a factor is refused (fail closed).
 */
export async function renewalMfaGate(user: {
  id: string;
  roleId: string;
  mfaEnabled: boolean;
  mfaMethod: string | null;
}): Promise<RenewalMfaGate> {
  const reading = await readMfaConfig();
  const counts = await mfaFactorCounts({ userId: user.id });
  if (usableFactors({ ...user, ...counts }, reading).length > 0) return 'renew';
  if (reading.fallback) return 'policy_unavailable';
  return (await mfaRequiredForRole(reading.config, user.roleId)) ? 'enrollment_required' : 'renew';
}

export interface MfaEnrollmentRejection {
  error: string;
  code: 'UNAUTHORIZED' | 'ACCOUNT_DEACTIVATED';
}

/**
 * Whether an enrollment JWT may still set up MFA: the user is active, the
 * token is of the current session version, and the account has no usable
 * factor. Once MFA is set up, the token is refused.
 */
export async function mfaEnrollmentTokenRejection(
  payload: Record<string, unknown>,
): Promise<MfaEnrollmentRejection | null> {
  const userId = payload['userId'];
  if (typeof userId !== 'string' || payload['type'] === 'driver') {
    return { error: 'Unauthorized', code: 'UNAUTHORIZED' };
  }
  const state = await getUserSessionState(userId);
  if (!state.active) return { error: 'Account deactivated', code: 'ACCOUNT_DEACTIVATED' };
  const sv = typeof payload['sv'] === 'number' ? payload['sv'] : 0;
  if (sv !== state.sessionVersion) return { error: 'Session ended', code: 'UNAUTHORIZED' };

  const [user] = await db
    .select({ mfaEnabled: users.mfaEnabled, mfaMethod: users.mfaMethod })
    .from(users)
    .where(eq(users.id, userId));
  if (user == null) return { error: 'Unauthorized', code: 'UNAUTHORIZED' };
  const factors = usableFactors(
    { ...user, ...(await mfaFactorCounts({ userId })) },
    await readMfaConfig(),
  );
  if (factors.length > 0) return { error: 'MFA is already set up', code: 'UNAUTHORIZED' };
  return null;
}

/**
 * Whether an MFA pending token was signed under the account's current session
 * version: a password change, reset or sign-out after the password step ends it.
 */
export function mfaPendingTokenCurrent(payload: object, sessionVersion: number): boolean {
  const sv = (payload as { sv?: unknown }).sv;
  return typeof sv === 'number' && sv === sessionVersion;
}

/** The 401 reply of an MFA pending token that is expired or no longer current. */
export async function sendMfaTokenExpired(reply: FastifyReply): Promise<void> {
  await reply
    .status(401)
    .send({ error: 'Invalid or expired MFA token', code: 'MFA_TOKEN_EXPIRED' });
}

/** The token of a Bearer Authorization header, or null for no header or another scheme. */
export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers['authorization'];
  if (header == null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Guard for the operator MFA setup and confirm routes: a signed-in session
 * (`selfService()`), or the enrollment JWT a required or switched-off MFA
 * sign-in hands out. Every other route refuses that JWT.
 */
export function selfServiceOrMfaEnrollment() {
  const sessionGuard = selfService();
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request);
    if (token != null) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = request.server.jwt.verify<Record<string, unknown>>(token);
      } catch (err) {
        // The session guard below checks the header again and answers 401.
        request.log.debug({ err }, 'Bearer token is not a valid JWT, checking for a session');
      }
      if (payload?.['mfaEnrollment'] === true) {
        const rejection = await mfaEnrollmentTokenRejection(payload);
        if (rejection != null) {
          await reply.status(401).send(rejection);
          return;
        }
        (request as unknown as Record<string, unknown>)['user'] = payload;
        return;
      }
    }
    await sessionGuard(request, reply);
  };
}

/** Whether the request runs with an enrollment JWT (accepted by `selfServiceOrMfaEnrollment`). */
export function isMfaEnrollmentRequest(request: FastifyRequest): boolean {
  return (request.user as { mfaEnrollment?: unknown }).mfaEnrollment === true;
}
