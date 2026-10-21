// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, drivers, readMfaConfig, type MfaConfig } from '@evtivity/database';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import type { DriverJwtPayload } from '../plugins/auth.js';
import type { MfaContact } from './mfa-contact.js';
import { sendSignInMfaCode } from './sign-in-backoff.js';
import { hasMfa, mfaSignInFactors, usableFactors, type MfaFactor } from './mfa-factors.js';
import {
  MFA_ENROLLMENT_TOKEN_TTL,
  availableMfaMethods,
  bearerToken,
  type MfaEnrollmentRejection,
  type MfaPolicyDecision,
  type MfaPolicyUnavailable,
  type MfaSetupMethod,
  type MfaSetupUnavailable,
  type RenewalMfaGate,
} from './mfa-enrollment.js';
import { getDriverSessionState } from './driver-active.js';
import { mfaFactorCounts } from '../services/mfa-factor.service.js';

/** The driver fields the portal MFA gate reads. */
export interface DriverMfaAccount extends MfaContact {
  id: string;
  mfaEnabled: boolean;
  mfaMethod: string | null;
  /** The session version the enrollment JWT carries (the current one). */
  sessionVersion: number;
}

/** What the portal login hands back instead of a session: the input of POST /v1/portal/auth/mfa/verify. */
export interface DriverMfaPending {
  mfaRequired: true;
  mfaMethod: string;
  mfaToken: string;
  challengeId: number | undefined;
  /** The factors the challenge may use: the method while it is usable, recovery codes while any are left, and passkeys. */
  factors: MfaFactor[];
  /** Set when an admin switched the method off and another factor remains: no code was sent. */
  mfaMethodDisabled?: true;
}

/** The portal sign-in reply instead of a session: the driver must set up MFA first. */
export interface DriverMfaEnrollment {
  mfaEnrollmentRequired: true;
  enrollmentToken: string;
  availableMethods: MfaSetupMethod[];
  /** A passkey or security key can be the enrolled factor (POST /v1/portal/driver/webauthn/registration). */
  webauthnAvailable: boolean;
}

/**
 * The mobile app (`X-Client: mobile`) can neither enroll a factor during sign-in nor use a
 * passkey or a recovery code: such a sign-in is refused, and the driver finishes in the portal.
 * `enrollment`: required MFA and the driver has none. `factor`: no factor the app can prove.
 * `method_disabled`: an admin switched off the driver's only factor, so another must be set up.
 */
export interface DriverMobileMfaUnsupported {
  mobileMfaUnsupported: 'enrollment' | 'factor' | 'method_disabled';
}

/** The second factors the mobile app can prove at sign-in: a code by email, SMS or authenticator app. */
const MOBILE_FACTORS: readonly MfaFactor[] = ['email', 'sms', 'totp'];

export type DriverMfaGateReply =
  | DriverMfaPending
  | DriverMfaEnrollment
  | MfaSetupUnavailable
  | MfaPolicyUnavailable
  | DriverMobileMfaUnsupported;

/** Whether required MFA covers drivers, or `unavailable` when no settings could be read. */
export async function driverMfaPolicy(): Promise<MfaPolicyDecision> {
  const reading = await readMfaConfig();
  if (reading.fallback) return 'unavailable';
  return reading.config.requireDrivers ? 'required' : 'not_required';
}

/**
 * The 10-minute driver enrollment JWT. It carries the session version, so
 * the session the confirm step issues (which raises the version) ends it.
 */
function signDriverMfaEnrollmentToken(
  app: FastifyInstance,
  driver: { id: string; sessionVersion: number },
): string {
  return app.jwt.sign(
    { driverId: driver.id, type: 'driver', mfaEnrollment: true, sv: driver.sessionVersion },
    { expiresIn: MFA_ENROLLMENT_TOKEN_TTL },
  );
}

/**
 * Required MFA for a driver without MFA (`security.mfa.requireDrivers`): the
 * enrollment reply when it is on, else null. When no method can be set up the
 * sign-in is refused, and a failed settings read with nothing cached refuses
 * it too (fail closed). A mobile client gets no enrollment token.
 */
async function requiredDriverMfaEnrollment(
  app: FastifyInstance,
  driver: DriverMfaAccount,
  mobile: boolean,
): Promise<
  | DriverMfaEnrollment
  | MfaSetupUnavailable
  | MfaPolicyUnavailable
  | DriverMobileMfaUnsupported
  | null
> {
  const reading = await readMfaConfig();
  if (reading.fallback) {
    app.log.error(
      { driverId: driver.id },
      'The MFA settings could not be read, so required MFA refuses the sign-in',
    );
    return { mfaPolicyUnavailable: true };
  }
  if (!reading.config.requireDrivers) return null;
  const availableMethods = availableMfaMethods(reading.config, driver);
  if (availableMethods.length === 0) {
    app.log.error(
      { driverId: driver.id },
      'Required MFA covers drivers but no method can be set up, sign-in refused',
    );
    return { mfaSetupUnavailable: true };
  }
  if (mobile) return { mobileMfaUnsupported: 'enrollment' };
  return {
    mfaEnrollmentRequired: true,
    enrollmentToken: signDriverMfaEnrollmentToken(app, driver),
    availableMethods,
    webauthnAvailable: reading.config.webauthnEnabled,
  };
}

/**
 * The portal MFA gate, the driver side of beginOperatorMfa: for a driver with MFA (a method
 * or a passkey) it signs the 3-minute MFA pending JWT and sends the email or SMS code. A driver
 * without MFA whom required MFA covers gets the enrollment reply, or a refusal when no method
 * can be set up or no MFA settings could be read. Null when the driver signs in without MFA.
 * A method switched off in Settings > Security > MFA gets no code while the driver has another
 * factor: POST /v1/portal/auth/mfa/verify refuses it with MFA_METHOD_DISABLED.
 */
export async function beginDriverMfa(
  app: FastifyInstance,
  driver: DriverMfaAccount,
  opts: { mobile: boolean },
): Promise<DriverMfaGateReply | null> {
  const counts = await mfaFactorCounts({ driverId: driver.id });
  if (!hasMfa({ ...driver, ...counts })) {
    return requiredDriverMfaEnrollment(app, driver, opts.mobile);
  }

  const { gate, factors, methodDisabled } = mfaSignInFactors(
    { ...driver, ...counts },
    await readMfaConfig(),
  );
  if (opts.mobile) {
    // A switched-off method that is the only factor leads to enrollment, which the app
    // cannot do during sign-in.
    if (gate === 'enrollment_required') return { mobileMfaUnsupported: 'method_disabled' };
    // The app proves codes only: without one it would show a code field that can never pass.
    if (!factors.some((f) => MOBILE_FACTORS.includes(f))) {
      return { mobileMfaUnsupported: 'factor' };
    }
  }

  // The pending token carries the session version, so a password change or sign-out between
  // the password step and the second factor ends it.
  const mfaToken = app.jwt.sign(
    {
      driverId: driver.id,
      type: 'driver',
      mfaPending: true,
      sv: driver.sessionVersion,
    } satisfies DriverJwtPayload,
    { expiresIn: '3m' },
  );

  let challengeId: number | undefined;
  if (
    gate !== 'refused' &&
    driver.mfaEnabled &&
    (driver.mfaMethod === 'email' || driver.mfaMethod === 'sms')
  ) {
    challengeId = await sendSignInMfaCode(
      { driverId: driver.id },
      driver.mfaMethod,
      driver,
      ALL_TEMPLATES_DIRS,
    );
  }

  return {
    mfaRequired: true,
    // A driver whose only factor is a passkey or security key has no primary method.
    mfaMethod: driver.mfaEnabled && driver.mfaMethod != null ? driver.mfaMethod : 'passkey',
    mfaToken,
    challengeId,
    factors,
    ...(methodDisabled ? { mfaMethodDisabled: true as const } : {}),
  };
}

/**
 * After the MFA step proved a switched-off factor that was the driver's only one, as for
 * operators: a web client gets the enrollment reply and no session; the mobile app, which
 * cannot enroll during sign-in, is refused. Null when no method can be set up: the session
 * is then issued rather than locking the driver out.
 */
export function driverMfaEnrollmentAfterVerify(
  app: FastifyInstance,
  driver: DriverMfaAccount,
  config: MfaConfig,
  opts: { mobile: boolean },
): DriverMfaEnrollment | DriverMobileMfaUnsupported | null {
  const availableMethods = availableMfaMethods(config, driver);
  if (availableMethods.length === 0) {
    app.log.warn(
      { driverId: driver.id },
      'MFA setup is needed but no method can be set up, signing in without it',
    );
    return null;
  }
  if (opts.mobile) return { mobileMfaUnsupported: 'method_disabled' };
  return {
    mfaEnrollmentRequired: true,
    enrollmentToken: signDriverMfaEnrollmentToken(app, driver),
    availableMethods,
    webauthnAvailable: config.webauthnEnabled,
  };
}

/** The `login_failed` audit reason of a mobile sign-in the app cannot finish. */
export function mobileMfaUnsupportedAuditReason(
  reason: DriverMobileMfaUnsupported['mobileMfaUnsupported'],
): string {
  if (reason === 'enrollment') return 'mfa_enrollment_required';
  if (reason === 'method_disabled') return 'mfa_method_disabled';
  return 'mfa_factor_unsupported';
}

/** Whether a gate reply refuses a mobile sign-in that only the portal can finish. */
export function isDriverMobileMfaUnsupported(reply: object): reply is DriverMobileMfaUnsupported {
  return 'mobileMfaUnsupported' in reply;
}

/**
 * The reply of a mobile sign-in that only the portal can finish: 403
 * MFA_ENROLLMENT_REQUIRED with a message the app shows as it is (the app has
 * no translation for the code), naming the portal.
 */
export async function sendMobileMfaUnsupported(
  reply: FastifyReply,
  reason: DriverMobileMfaUnsupported['mobileMfaUnsupported'],
  portalUrl: string,
): Promise<void> {
  const messages: Record<DriverMobileMfaUnsupported['mobileMfaUnsupported'], string> = {
    enrollment: `Two-factor authentication is required for your account. Set it up in the driver portal at ${portalUrl} in a web browser, then sign in here again.`,
    factor: `Your account signs in with a second factor this app does not support yet. Sign in to the driver portal at ${portalUrl} in a web browser to set up an authenticator app, email or SMS codes, then sign in here again.`,
    method_disabled: `Your sign-in method was turned off. Set up another one in the driver portal at ${portalUrl}, then sign in here again.`,
  };
  const error = messages[reason];
  await reply.status(403).send({ error, code: 'MFA_ENROLLMENT_REQUIRED', portalUrl });
}

/**
 * Required MFA at a driver session renewal, as for operators: a driver with a
 * usable factor renews; a driver without one renews only while required MFA
 * does not cover drivers; when no settings can be read, a driver without a
 * factor is refused (fail closed).
 */
export async function driverRenewalMfaGate(driver: {
  id: string;
  mfaEnabled: boolean;
  mfaMethod: string | null;
}): Promise<RenewalMfaGate> {
  const reading = await readMfaConfig();
  const counts = await mfaFactorCounts({ driverId: driver.id });
  if (usableFactors({ ...driver, ...counts }, reading).length > 0) return 'renew';
  if (reading.fallback) return 'policy_unavailable';
  return reading.config.requireDrivers ? 'enrollment_required' : 'renew';
}

/**
 * Whether a driver enrollment JWT may still set up MFA: the driver is active,
 * the token is of the current session version, and the driver has no usable
 * factor. Once MFA is set up, the token is refused.
 */
async function driverMfaEnrollmentTokenRejection(
  payload: Record<string, unknown>,
): Promise<MfaEnrollmentRejection | null> {
  const driverId = payload['driverId'];
  if (typeof driverId !== 'string' || payload['type'] !== 'driver') {
    return { error: 'Unauthorized', code: 'UNAUTHORIZED' };
  }
  const state = await getDriverSessionState(driverId);
  if (!state.active) return { error: 'Account deactivated', code: 'ACCOUNT_DEACTIVATED' };
  const sv = typeof payload['sv'] === 'number' ? payload['sv'] : 0;
  if (sv !== state.sessionVersion) return { error: 'Session ended', code: 'UNAUTHORIZED' };

  const [driver] = await db
    .select({ mfaEnabled: drivers.mfaEnabled, mfaMethod: drivers.mfaMethod })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  if (driver == null) return { error: 'Unauthorized', code: 'UNAUTHORIZED' };
  const factors = usableFactors(
    { ...driver, ...(await mfaFactorCounts({ driverId })) },
    await readMfaConfig(),
  );
  if (factors.length > 0) return { error: 'MFA is already set up', code: 'UNAUTHORIZED' };
  return null;
}

/**
 * Guard for the portal MFA setup and confirm routes and the passkey
 * registration: a signed-in driver (`app.authenticateDriver`), or the driver
 * enrollment JWT a required MFA sign-in hands out, as Bearer only. Every other
 * route refuses that JWT (`driverTokenRejection`).
 */
export function authenticateDriverOrMfaEnrollment(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request);
    if (token != null) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = request.server.jwt.verify<Record<string, unknown>>(token);
      } catch (err) {
        // The driver guard below checks the header again and answers 401.
        request.log.debug({ err }, 'Bearer token is not a valid JWT, checking for a session');
      }
      if (payload?.['mfaEnrollment'] === true) {
        const rejection = await driverMfaEnrollmentTokenRejection(payload);
        if (rejection != null) {
          await reply.status(401).send(rejection);
          return;
        }
        (request as unknown as Record<string, unknown>)['user'] = payload;
        request.driverAuthSource = 'bearer';
        return;
      }
    }
    await app.authenticateDriver(request, reply);
  };
}

/** Whether the request runs with a driver enrollment JWT. */
export function isDriverMfaEnrollmentRequest(request: FastifyRequest): boolean {
  return (request.user as { mfaEnrollment?: unknown }).mfaEnrollment === true;
}
