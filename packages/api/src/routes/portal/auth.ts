// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, and, gt, isNull, isNotNull } from 'drizzle-orm';
import argon2 from 'argon2';
import {
  db,
  client,
  readMfaConfig,
  isPortalRegistrationEnabled,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
  resolveAccountBilling,
  writeAudit,
  driverAuditLog,
} from '@evtivity/database';
import { drivers, userTokens } from '@evtivity/database';
import {
  dispatchDriverNotification,
  dispatchSystemNotification,
  decryptString,
  isMfaChallengeLimited,
  verifyMfaChallenge,
  matchTotpStep,
} from '@evtivity/lib';
import { clearAuthCookies, isSecureRequest, readRefreshCookie } from '../../lib/auth-cookies.js';
import { zodSchema } from '../../lib/zod-schema.js';
import { portalDriverItem } from '../../lib/portal-driver-item.js';
import { emailEquals } from '../../lib/email-match.js';
import { generateUserToken, hashUserToken } from '../../lib/user-token.js';
import {
  newPasswordSchema,
  validatePassword,
  weakPasswordFields,
} from '../../lib/password-validation.js';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { itemResponse, successResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import { checkRecaptcha } from '../../lib/recaptcha-check.js';
import { driverBillingAddressItem } from '../../lib/driver-billing-address-schema.js';
import { driverBillingAddressColumns } from '../../services/driver-billing.service.js';
import {
  isPhoneRegistrationLimited,
  registrationPhone,
  verificationResendRetryAfter,
} from '../../lib/signup-limits.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import {
  validateAndRotateRefreshToken,
  revokeRefreshToken,
  bumpDriverSessionVersion,
  endDriverSessions,
  sessionRefreshTokenDriverId,
} from '../../services/refresh-token.service.js';
import { config as apiConfig } from '../../lib/config.js';
import { driverBillingSchema, toDriverBilling } from '../../lib/portal-billing.js';
import { recordAuthAudit } from '../../lib/auth-audit.js';
import { activateDriverPortal } from '../../services/driver-portal-access.service.js';
import { verifyAgainstDummyHash } from '../../lib/dummy-password-hash.js';
import { verifyPassword } from '../../lib/password-verify.js';
import {
  acceptTotpStep,
  clearSignInFailures,
  createAccountMfaChallenge,
  sendMfaResendLimited,
  recordAttemptFailure,
  secondsUntil,
  takeSignInAttempt,
} from '../../lib/sign-in-backoff.js';
import { sendDriverEmailVerification } from '../../lib/driver-email-verification.js';
import { mfaCodeDestination, mfaCodeRecipient } from '../../lib/mfa-contact.js';
import {
  beginDriverMfa,
  driverMfaEnrollmentAfterVerify,
  driverRenewalMfaGate,
  isDriverMobileMfaUnsupported,
  mobileMfaUnsupportedAuditReason,
  sendMobileMfaUnsupported,
} from '../../lib/driver-mfa.js';
import {
  isMfaPolicyUnavailable,
  isMfaSetupUnavailable,
  MFA_SETUP_METHODS,
  mfaPendingTokenCurrent,
  sendMfaTokenExpired,
} from '../../lib/mfa-enrollment.js';
import { INVALID_PHONE_REPLY, readPhoneInput } from '../../lib/phone-input.js';
import {
  MFA_FACTORS,
  hasMfa,
  mfaMethodGate,
  passkeyGate,
  usableFactors,
} from '../../lib/mfa-factors.js';
import { accountAuditActor } from '../../lib/audit-actor.js';
import { consumeRecoveryCode, mfaFactorCounts } from '../../services/mfa-factor.service.js';
import {
  issueDriverSession,
  issueDriverTokens,
  isMobileClient,
  deviceIdFromRequest,
} from '../../lib/driver-session.js';
import { driverSessionColumns } from '../../lib/driver-session-columns.js';
import {
  issueChallenge,
  registerIosAttestation,
  verifyDeviceAttestation,
} from '../../lib/device-attestation/index.js';

// GET /portal/auth/me also tells the portal and the app how the driver pays.
const portalDriverMe = portalDriverItem
  .extend({
    billing: driverBillingSchema.describe(
      'How the driver pays a session they start: account (billed to a fleet, no payment method needed) or card. A free vend site bills nothing either way',
    ),
    billingAddress: driverBillingAddressItem.describe(
      'The bill-to block of the invoices a fleet addresses to the driver (PATCH /v1/portal/driver/billing-address)',
    ),
  })
  .passthrough();

// Mobile clients (X-Client: mobile) receive these in the body instead of cookies.
const mobileSessionFields = {
  token: z.string().optional().describe('Access JWT, mobile clients only'),
  refreshToken: z.string().optional().describe('Opaque refresh token, mobile clients only'),
  expiresIn: z.number().int().optional().describe('Access token lifetime in seconds'),
};

const portalAuthLoginResponse = z
  .object({
    driver: portalDriverItem.optional(),
    mfaRequired: z.boolean().optional(),
    mfaMethod: z
      .enum(['email', 'sms', 'totp', 'passkey'])
      .optional()
      .describe('With mfaRequired: the primary method, or passkey for a driver with passkeys only'),
    mfaToken: z.string().optional(),
    challengeId: z.number().int().min(1).optional(),
    factors: z
      .array(z.enum(MFA_FACTORS))
      .optional()
      .describe(
        'With mfaRequired: the factors the MFA step accepts (the method while it is usable, recovery_code while recovery codes are left)',
      ),
    mfaMethodDisabled: z
      .boolean()
      .optional()
      .describe(
        'With mfaRequired: the method is switched off by an admin and no code was sent; use a recovery code',
      ),
    mfaEnrollmentRequired: z
      .boolean()
      .optional()
      .describe(
        'Required MFA (Settings > Security > MFA) covers drivers and this driver has none: no session is issued; set up MFA with enrollmentToken. Web clients only: a mobile client gets 403 MFA_ENROLLMENT_REQUIRED instead',
      ),
    enrollmentToken: z
      .string()
      .optional()
      .describe(
        'With mfaEnrollmentRequired: a 10-minute Bearer token valid only for POST /v1/portal/driver/mfa/setup, /confirm and the passkey registration routes',
      ),
    availableMethods: z
      .array(z.enum(MFA_SETUP_METHODS))
      .optional()
      .describe('With mfaEnrollmentRequired: the methods the driver can set up now'),
    webauthnAvailable: z
      .boolean()
      .optional()
      .describe('With mfaEnrollmentRequired: a passkey or security key can be the enrolled factor'),
    ...mobileSessionFields,
  })
  .passthrough();

const portalRefreshResponse = z
  .object({
    success: z.boolean().optional().describe('Web cookie mode'),
    ...mobileSessionFields,
  })
  .passthrough();

const registerBody = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().max(255),
  password: newPasswordSchema,
  phone: z.string().max(50).optional(),
  recaptchaToken: z.string().optional().describe('reCAPTCHA v3 token'),
});

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  recaptchaToken: z.string().optional().describe('reCAPTCHA v3 token'),
});

const attestRegisterBody = z.object({
  keyId: z.string().min(1).max(512).describe('Base64 App Attest key id'),
  attestation: z.string().min(1).describe('Base64 CBOR attestation object'),
  challenge: z.string().min(1).max(128).describe('Challenge nonce from /attest/challenge'),
});

const attestChallengeResponse = z
  .object({ challenge: z.string().describe('Single-use base64url nonce, valid 5 minutes') })
  .passthrough();

/**
 * Records a portal login refused by the active-account lookup on the driver the
 * email names: an inactive driver, or one without portal access (no password).
 * An unknown email writes no audit row; access_logs holds the request.
 */
async function recordRefusedDriverLogin(request: FastifyRequest, email: string): Promise<void> {
  try {
    const [existing] = await db
      .select({
        id: drivers.id,
        isActive: drivers.isActive,
      })
      .from(drivers)
      .where(emailEquals(drivers.email, email))
      .limit(1);
    if (existing == null) return;
    await recordAuthAudit(request, {
      kind: 'driver',
      accountId: existing.id,
      action: 'login_failed',
      method: 'password',
      reason: existing.isActive ? 'no_portal_access' : 'inactive',
    });
  } catch (err) {
    request.log.warn({ err }, 'refused portal login audit failed');
  }
}

/**
 * Tells the holder of an email that someone tried to register with it: the
 * registration answers the same for a known email, so the owner learns of
 * the attempt here instead. Email only, no account change, not awaited (the
 * answer must not take longer for a known email), fail-open with a log.
 */
function notifyRegistrationAttempt(
  driver: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    language: string;
  },
  request: FastifyRequest,
): void {
  if (driver.email == null) return;
  void dispatchSystemNotification(
    client,
    'driver.RegistrationAttempt',
    { email: driver.email, firstName: driver.firstName, language: driver.language },
    {
      firstName: driver.firstName,
      lastName: driver.lastName,
      email: driver.email,
      signInUrl: `${apiConfig.PORTAL_URL}/login`,
      resetUrl: `${apiConfig.PORTAL_URL}/forgot-password`,
    },
    ALL_TEMPLATES_DIRS,
  ).catch((err: unknown) => {
    request.log.warn({ err, driverId: driver.id }, 'Registration attempt notice failed');
  });
}

export function portalAuthRoutes(app: FastifyInstance): void {
  app.post(
    '/portal/auth/attest/challenge',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Issue a device-attestation challenge',
        description:
          'Returns a single-use nonce the mobile app signs with Apple App Attest or feeds to Google Play Integrity. The nonce expires in 5 minutes and is consumed on the next attested auth request.',
        operationId: 'portalAttestChallenge',
        security: [],
        response: { 200: itemResponse(attestChallengeResponse) },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (_request, reply) => {
      const challenge = await issueChallenge();
      await reply.status(200).send({ challenge });
    },
  );

  app.post(
    '/portal/auth/attest/register',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Register an iOS App Attest key',
        description:
          'One-time iOS registration. Verifies the App Attest attestation against the Apple root and stores the device public key (keyed by X-Device-Id) so later assertions can be checked. Android Play Integrity is stateless and needs no registration. Returns 403 when verification fails or attestation is disabled.',
        operationId: 'portalAttestRegister',
        security: [],
        body: zodSchema(attestRegisterBody),
        response: {
          200: successResponse,
          403: errorWith('Attestation failed', [ERROR_CODES.ATTESTATION_FAILED]),
        },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const result = await registerIosAttestation(request);
      if (!result.ok) {
        await reply
          .status(403)
          .send({ error: 'Device attestation failed', code: 'ATTESTATION_FAILED' });
        return;
      }
      await reply.status(200).send({ success: true });
    },
  );

  app.post(
    '/portal/auth/register',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Register a new driver account',
        description:
          'Answers 202 { success: true } for a new and for an existing email alike, so the answer does not reveal whether an account exists, and signs nobody in. A new email gets a driver row (registrationSource=portal, argon2 password) and a verification email; the driver signs in after opening the link. An existing email (active or not, with or without portal access) changes nothing and gets driver.RegistrationAttempt, an email with the sign-in and password reset links. Verifies the reCAPTCHA token when enabled (web) or the device attestation (mobile apps). Returns 400 WEAK_PASSWORD, 400 VALIDATION_ERROR for a phone number that does not parse (stored in E.164), 429 PHONE_REGISTRATION_LIMITED when the phone number was used in three portal registrations in the last 24 hours, and 403 if portal registration is disabled by settings.',
        operationId: 'portalRegister',
        security: [],
        body: zodSchema(registerBody),
        response: {
          202: successResponse,
          400: errorWith(
            'Weak password or invalid phone number',
            [ERROR_CODES.WEAK_PASSWORD, ERROR_CODES.VALIDATION_ERROR],
            weakPasswordFields,
          ),
          403: errorWith('Forbidden', [
            ERROR_CODES.PORTAL_REGISTRATION_DISABLED,
            ERROR_CODES.ATTESTATION_FAILED,
          ]),
          429: errorWith('Too many registrations with this phone number', [
            ERROR_CODES.PHONE_REGISTRATION_LIMITED,
          ]),
          500: errorWith('Internal server error', [
            ERROR_CODES.INTERNAL_ERROR,
            ERROR_CODES.DRIVER_CREATE_FAILED,
          ]),
        },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof registerBody>;

      // Operator-toggleable kill switch for the portal Register page.
      // Defaults true; closed/admin-provisioned deployments flip it off.
      if (!(await isPortalRegistrationEnabled())) {
        await reply.status(403).send({
          error: 'Driver self-registration is disabled',
          code: 'PORTAL_REGISTRATION_DISABLED',
        });
        return;
      }

      const weakPassword = await validatePassword(body.password);
      if (weakPassword != null) {
        await reply.status(400).send(weakPassword);
        return;
      }

      // Native apps cannot produce a reCAPTCHA token. When device attestation
      // is enabled they prove themselves with a signed App Attest / Play
      // Integrity token; otherwise they fall back to the endpoint rate limit.
      if (isMobileClient(request)) {
        const attested = await verifyDeviceAttestation(request);
        if (!attested) {
          await reply
            .status(403)
            .send({ error: 'Device attestation failed', code: 'ATTESTATION_FAILED' });
          return;
        }
      } else {
        const recaptchaOk = await checkRecaptcha(body.recaptchaToken, reply);
        if (!recaptchaOk) return;
      }

      // Per-contact cap on top of the per-IP rate limit, so one phone number cannot seed many
      // accounts. Stored normalized so formatting variants count as the same number. Checked
      // before the email lookup, so its answer says nothing about the email.
      if (readPhoneInput(body.phone).kind === 'invalid') {
        await reply.status(400).send(INVALID_PHONE_REPLY);
        return;
      }
      const phone = registrationPhone(body.phone);
      if (phone != null && (await isPhoneRegistrationLimited(phone))) {
        await reply.status(429).send({
          error: 'Too many accounts were registered with this phone number. Try again later.',
          code: 'PHONE_REGISTRATION_LIMITED',
        });
        return;
      }

      // Hashed for a known email too, so both answers take the same time.
      const passwordHash = await argon2.hash(body.password);

      // Case-insensitive exact match so jane@x.com cannot register again as Jane@x.com.
      const [existing] = await db
        .select({
          id: drivers.id,
          firstName: drivers.firstName,
          lastName: drivers.lastName,
          email: drivers.email,
          language: drivers.language,
        })
        .from(drivers)
        .where(emailEquals(drivers.email, body.email));

      if (existing != null) {
        notifyRegistrationAttempt(existing, request);
        await reply.status(202).send({ success: true });
        return;
      }

      let driver;
      try {
        [driver] = await db
          .insert(drivers)
          .values({
            firstName: body.firstName,
            lastName: body.lastName,
            email: body.email,
            phone,
            passwordHash,
            registrationSource: 'portal',
          })
          .returning(driverSessionColumns);
      } catch (err) {
        // The email lookup above is non-transactional, so two concurrent
        // registrations with the same email both reach this INSERT. The partial
        // unique index on LOWER(email) (migration 0052) makes the loser 23505:
        // it answers like any other existing email.
        if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
          await reply.status(202).send({ success: true });
          return;
        }
        throw err;
      }
      if (driver == null) {
        await reply
          .status(500)
          .send({ error: 'Failed to create driver', code: 'DRIVER_CREATE_FAILED' });
        return;
      }

      await writeAudit(
        { table: driverAuditLog, idColumn: 'driver_id' },
        {
          entityId: driver.id,
          entityIdSnapshot: driver.id,
          action: 'created',
          actor: 'driver',
          actorDriverId: driver.id,
          after: driver,
          notes: 'Registered in the driver portal',
        },
        db,
        request.log,
      );

      if (driver.email != null) {
        await sendDriverEmailVerification({ ...driver, email: driver.email }, request.log);
      }
      await reply.status(202).send({ success: true });
    },
  );

  app.post(
    '/portal/auth/login',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Log in with email and password',
        operationId: 'portalLogin',
        security: [],
        body: zodSchema(loginBody),
        response: {
          200: itemResponse(portalAuthLoginResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.RECAPTCHA_REQUIRED,
          ]),
          401: errorWith('Invalid credentials', [ERROR_CODES.INVALID_CREDENTIALS]),
          403: errorWith(
            'Forbidden, or a mobile sign-in only the portal can finish (MFA_ENROLLMENT_REQUIRED, with portalUrl)',
            [
              ERROR_CODES.FORBIDDEN,
              ERROR_CODES.MFA_ENROLLMENT_REQUIRED,
              ERROR_CODES.MFA_SETUP_UNAVAILABLE,
              ERROR_CODES.RECAPTCHA_FAILED,
            ],
            {
              portalUrl: z
                .string()
                .optional()
                .describe('MFA_ENROLLMENT_REQUIRED: the driver portal, where the driver finishes'),
            },
          ),
          503: errorWith('MFA settings unavailable', [ERROR_CODES.MFA_POLICY_UNAVAILABLE]),
        },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const { email, password, recaptchaToken } = request.body as z.infer<typeof loginBody>;

      // reCAPTCHA v3 is a browser technology; native apps cannot produce a
      // token. Mobile clients instead present a device-attestation token when
      // attestation is enabled, and otherwise rely on the per-endpoint rate
      // limit. checkRecaptcha is a no-op when reCAPTCHA is disabled, so web is
      // unaffected on those deployments.
      if (isMobileClient(request)) {
        const attested = await verifyDeviceAttestation(request);
        if (!attested) {
          await reply
            .status(403)
            .send({ error: 'Device attestation failed', code: 'ATTESTATION_FAILED' });
          return;
        }
      } else {
        const recaptchaOk = await checkRecaptcha(recaptchaToken, reply);
        if (!recaptchaOk) return;
      }

      // Case-insensitive match so a driver who registered as Jane@x.com can log in
      // typing jane@x.com. The register path uses the same match for the
      // duplicate check, so login must match for the round-trip to work.
      // A driver an operator created has no password until they accept a
      // portal invite.
      const [driver] = await db
        .select()
        .from(drivers)
        .where(
          and(
            emailEquals(drivers.email, email),
            isNotNull(drivers.passwordHash),
            eq(drivers.isActive, true),
          ),
        );

      if (driver == null || driver.passwordHash == null) {
        // Same time as a wrong password on a real account, so the response
        // time does not tell whether the email has a portal account.
        await verifyAgainstDummyHash(password);
        await recordRefusedDriverLogin(request, email);
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }

      // A locked driver (sign-in backoff) answers as for a wrong password, after the same time.
      // The try is counted in the UPDATE that checks the lock, so parallel guesses cannot pass it.
      const attempt = await takeSignInAttempt({ driverId: driver.id }, 'password');
      if (!attempt.granted) {
        await verifyAgainstDummyHash(password);
        await recordAuthAudit(request, {
          kind: 'driver',
          accountId: driver.id,
          action: 'login_failed',
          method: 'password',
          reason: 'locked',
        });
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }

      const valid = await verifyPassword(driver.passwordHash, password, request.log);
      if (!valid) {
        await recordAuthAudit(request, {
          kind: 'driver',
          accountId: driver.id,
          action: 'login_failed',
          method: 'password',
          reason: 'bad_password',
        });
        await recordAttemptFailure(request, attempt);
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }
      await clearSignInFailures({ driverId: driver.id }, 'password');

      const gated = await beginDriverMfa(app, driver, { mobile: isMobileClient(request) });
      if (gated != null) {
        if (isMfaPolicyUnavailable(gated)) {
          await recordAuthAudit(request, {
            kind: 'driver',
            accountId: driver.id,
            action: 'login_failed',
            method: 'password',
            reason: 'mfa_policy_unavailable',
          });
          await reply.status(503).send({
            error: 'The MFA policy could not be read. Try again later.',
            code: 'MFA_POLICY_UNAVAILABLE',
          });
          return;
        }
        if (isMfaSetupUnavailable(gated)) {
          await recordAuthAudit(request, {
            kind: 'driver',
            accountId: driver.id,
            action: 'login_failed',
            method: 'password',
            reason: 'mfa_setup_unavailable',
          });
          await reply.status(403).send({
            error: 'MFA is required but no method can be set up. Contact the operator.',
            code: 'MFA_SETUP_UNAVAILABLE',
          });
          return;
        }
        if (isDriverMobileMfaUnsupported(gated)) {
          await recordAuthAudit(request, {
            kind: 'driver',
            accountId: driver.id,
            action: 'login_failed',
            method: 'password',
            reason: mobileMfaUnsupportedAuditReason(gated.mobileMfaUnsupported),
          });
          await sendMobileMfaUnsupported(reply, gated.mobileMfaUnsupported, apiConfig.PORTAL_URL);
          return;
        }
        // The MFA step, or the enrollment of required MFA: no session yet.
        return gated;
      }

      // Written before the session reply goes out, so the row exists when the
      // client sees the login succeed.
      await recordAuthAudit(request, {
        kind: 'driver',
        accountId: driver.id,
        action: 'login_succeeded',
        method: 'password',
      });
      await issueDriverSession(app, request, reply, {
        id: driver.id,
        firstName: driver.firstName,
        lastName: driver.lastName,
        email: driver.email,
        phone: driver.phone,
        language: driver.language,
        timezone: driver.timezone,
        themePreference: driver.themePreference,
        distanceUnit: driver.distanceUnit,
        priceDisplay: driver.priceDisplay,
        isActive: driver.isActive,
        emailVerified: driver.emailVerified,
        createdAt: driver.createdAt,
      });
      return;
    },
  );

  app.post(
    '/portal/auth/logout',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Auth'],
        summary: 'Log out',
        description:
          'Revokes the refresh token, ends every access token the driver holds (other devices renew with their own refresh token), and clears auth cookies. Web clients use the portal_refresh cookie; mobile clients (X-Client: mobile) send { refreshToken } in the body to revoke it server-side.',
        operationId: 'portalLogout',
        security: [{ bearerAuth: [] }],
        response: { 204: { type: 'null' as const } },
      },
    },
    async (request, reply) => {
      const mobile = isMobileClient(request);
      let rawRefreshToken: string | undefined;
      if (mobile) {
        rawRefreshToken = (request.body as { refreshToken?: string } | undefined)?.refreshToken;
      } else {
        const refreshCookie = readRefreshCookie('portal', request);
        if (refreshCookie.status === 'valid') rawRefreshToken = refreshCookie.value;
      }
      if (rawRefreshToken) {
        await revokeRefreshToken(rawRefreshToken);
      }
      // End the access tokens issued before, on every device, like the
      // operator logout. Other devices renew with their own refresh token.
      await bumpDriverSessionVersion((request.user as DriverJwtPayload).driverId);
      if (!mobile) clearAuthCookies('portal', reply, isSecureRequest(request));
      await reply.status(204).send();
    },
  );

  app.post(
    '/portal/auth/refresh',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Refresh the access token',
        description:
          'Rotates the refresh token and issues a new access token. Web clients use the portal_refresh cookie and receive new cookies. Mobile clients (X-Client: mobile) send { refreshToken } in the body and receive { token, refreshToken, expiresIn }; the token is device-bound via X-Device-Id. Rate limited to 30/min. Returns 401 if the token is missing, invalid, expired, revoked, the device does not match, or the driver is deactivated. While required MFA covers drivers, a driver without a usable factor gets 401 MFA_ENROLLMENT_REQUIRED and the refresh token is revoked (sign in again to set up MFA); 503 MFA_POLICY_UNAVAILABLE when the MFA settings cannot be read.',
        operationId: 'portalRefreshToken',
        security: [],
        response: {
          200: zodSchema(portalRefreshResponse),
          401: errorWith('Unauthorized', [
            ERROR_CODES.ACCOUNT_DISABLED,
            ERROR_CODES.NO_REFRESH_TOKEN,
            ERROR_CODES.INVALID_REFRESH_TOKEN,
            ERROR_CODES.MFA_ENROLLMENT_REQUIRED,
          ]),
          503: errorWith('MFA settings unavailable', [ERROR_CODES.MFA_POLICY_UNAVAILABLE]),
        },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const mobile = isMobileClient(request);
      const deviceId = mobile ? deviceIdFromRequest(request) : undefined;
      let rawToken: string | undefined;
      let invalidCookie = false;
      if (mobile) {
        rawToken = (request.body as { refreshToken?: string } | undefined)?.refreshToken;
      } else {
        const refreshCookie = readRefreshCookie('portal', request);
        if (refreshCookie.status === 'valid') rawToken = refreshCookie.value;
        invalidCookie = refreshCookie.status === 'invalid';
      }
      if (!rawToken && !invalidCookie) {
        await reply.status(401).send({ error: 'No refresh token', code: 'NO_REFRESH_TOKEN' });
        return;
      }

      // Required MFA reaches signed-in drivers here, before the token rotates, so a
      // settings read failure keeps the refresh token for the next try.
      if (rawToken) {
        const holderId = await sessionRefreshTokenDriverId(rawToken, deviceId);
        const [holder] =
          holderId == null
            ? []
            : await db
                .select({
                  id: drivers.id,
                  isActive: drivers.isActive,
                  mfaEnabled: drivers.mfaEnabled,
                  mfaMethod: drivers.mfaMethod,
                })
                .from(drivers)
                .where(eq(drivers.id, holderId));
        if (holder?.isActive === true) {
          const gate = await driverRenewalMfaGate(holder);
          if (gate === 'policy_unavailable') {
            request.log.error(
              { driverId: holder.id },
              'The MFA settings could not be read, so required MFA refuses the renewal',
            );
            await reply.status(503).send({
              error: 'The MFA policy could not be read. Try again later.',
              code: 'MFA_POLICY_UNAVAILABLE',
            });
            return;
          }
          if (gate === 'enrollment_required') {
            await revokeRefreshToken(rawToken);
            if (!mobile) clearAuthCookies('portal', reply, isSecureRequest(request));
            request.log.info(
              { driverId: holder.id },
              'Required MFA covers drivers and no factor is set up, the session is not renewed',
            );
            await reply
              .status(401)
              .send({ error: 'Set up MFA to continue', code: 'MFA_ENROLLMENT_REQUIRED' });
            return;
          }
        }
      }

      // A portal_refresh cookie whose signature does not verify is refused
      // like an unknown token: 401 INVALID_REFRESH_TOKEN and cleared cookies.
      const result = rawToken ? await validateAndRotateRefreshToken(rawToken, { deviceId }) : null;
      if (result == null || result.driverId == null) {
        if (!mobile) clearAuthCookies('portal', reply, isSecureRequest(request));
        await reply
          .status(401)
          .send({ error: 'Invalid refresh token', code: 'INVALID_REFRESH_TOKEN' });
        return;
      }

      const [driver] = await db
        .select({ id: drivers.id, isActive: drivers.isActive })
        .from(drivers)
        .where(eq(drivers.id, result.driverId));

      if (!driver || !driver.isActive) {
        if (!mobile) clearAuthCookies('portal', reply, isSecureRequest(request));
        await reply.status(401).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      // The renewal keeps the client of the refresh token, never the one the request names.
      const tokens = await issueDriverTokens(app, request, reply, driver.id, {
        client: result.client,
      });
      return tokens ?? { success: true };
    },
  );

  app.get(
    '/portal/auth/me',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Auth'],
        summary: 'Get the current authenticated driver profile',
        operationId: 'portalGetMe',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(portalDriverMe),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;

      const [row] = await db
        .select({ ...driverSessionColumns, ...driverBillingAddressColumns })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      if (row == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      const {
        billingName,
        billingStreet,
        billingCity,
        billingState,
        billingZip,
        billingCountry,
        ...driver
      } = row;
      return {
        ...driver,
        billing: toDriverBilling(await resolveAccountBilling(client, driverId)),
        billingAddress: {
          billingName,
          billingStreet,
          billingCity,
          billingState,
          billingZip,
          billingCountry,
        },
      };
    },
  );

  // Portal MFA verify
  const mfaVerifyBody = z.object({
    mfaToken: z.string().min(1),
    code: z
      .string()
      .min(6)
      .max(6)
      .optional()
      .describe('6-digit verification code; send either code or recoveryCode'),
    recoveryCode: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('A single-use recovery code (xxxxx-xxxxx), instead of code'),
    challengeId: z.coerce.number().int().min(1).optional(),
  });

  const portalMfaLoginResponse = z
    .object({
      driver: portalDriverItem
        .optional()
        .describe('The driver now signed in; absent with mfaEnrollmentRequired'),
      mfaEnrollmentRequired: z
        .boolean()
        .optional()
        .describe(
          'Set when the factor used is switched off by an admin and was the only one: no session is issued; set up another allowed method with enrollmentToken. Web clients only: a mobile client gets 403 MFA_ENROLLMENT_REQUIRED instead',
        ),
      enrollmentToken: z
        .string()
        .optional()
        .describe(
          'With mfaEnrollmentRequired: a 10-minute Bearer token valid only for POST /v1/portal/driver/mfa/setup, /confirm and the passkey registration routes',
        ),
      availableMethods: z
        .array(z.enum(MFA_SETUP_METHODS))
        .optional()
        .describe('With mfaEnrollmentRequired: the methods the driver can set up now'),
      webauthnAvailable: z
        .boolean()
        .optional()
        .describe(
          'With mfaEnrollmentRequired: a passkey or security key can be the enrolled factor',
        ),
      recoveryCodesRemaining: z
        .number()
        .int()
        .optional()
        .describe('After MFA with a recovery code: how many unused recovery codes are left'),
    })
    .passthrough();

  app.post(
    '/portal/auth/mfa/verify',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Verify MFA code and complete portal login',
        description:
          'Validates the short-lived MFA pending JWT, verifies the supplied TOTP code or email/SMS challenge code or a single-use recovery code, and on success sets portal session and refresh cookies. Codes expire after 5 minutes and are single-use. A recovery code works even when the method is switched off, is used up and returns recoveryCodesRemaining. Wrong codes count toward a per-driver backoff: after 5 in a row the driver is locked for 30 s, doubling up to 15 minutes, and verify answers 429 MFA_LOCKED with Retry-After. When the factor used is switched off and was the only one, no session is issued: a web client gets mfaEnrollmentRequired with an enrollmentToken, a mobile client 403 MFA_ENROLLMENT_REQUIRED.',
        operationId: 'portalVerifyMfa',
        security: [],
        body: zodSchema(mfaVerifyBody),
        response: {
          200: itemResponse(portalMfaLoginResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
            ERROR_CODES.MFA_CODE_INVALID,
            ERROR_CODES.MFA_NOT_CONFIGURED,
            ERROR_CODES.MFA_TOKEN_INVALID,
            ERROR_CODES.TOTP_NOT_CONFIGURED,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          401: errorWith('Unauthorized', [ERROR_CODES.UNAUTHORIZED, ERROR_CODES.MFA_TOKEN_EXPIRED]),
          403: errorWith('Forbidden', [
            ERROR_CODES.ACCOUNT_DISABLED,
            ERROR_CODES.MFA_ENROLLMENT_REQUIRED,
            ERROR_CODES.MFA_METHOD_DISABLED,
          ]),
          429: errorWith('Too many wrong codes', [ERROR_CODES.MFA_LOCKED]),
        },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const { mfaToken, code, recoveryCode, challengeId } = request.body as z.infer<
        typeof mfaVerifyBody
      >;
      if ((code == null) === (recoveryCode == null)) {
        await reply
          .status(400)
          .send({ error: 'Send either code or recoveryCode', code: 'VALIDATION_ERROR' });
        return;
      }

      let payload: { driverId: string; type: string; mfaPending?: boolean };
      try {
        payload = app.jwt.verify(mfaToken);
      } catch (err) {
        request.log.debug({ err }, 'MFA token did not verify, refusing it');
        await reply
          .status(401)
          .send({ error: 'Invalid or expired MFA token', code: 'MFA_TOKEN_EXPIRED' });
        return;
      }

      if (!payload.mfaPending || payload.type !== 'driver') {
        await reply.status(400).send({ error: 'Invalid MFA token', code: 'MFA_TOKEN_INVALID' });
        return;
      }

      const [driver] = await db.select().from(drivers).where(eq(drivers.id, payload.driverId));
      if (driver != null && !mfaPendingTokenCurrent(payload, driver.sessionVersion)) {
        await sendMfaTokenExpired(reply);
        return;
      }
      const factorCounts =
        driver != null
          ? await mfaFactorCounts({ driverId: driver.id })
          : { recoveryCodesRemaining: 0, passkeyCount: 0 };
      // A driver with passkeys only has no method to send a code for, but a recovery code works.
      const primaryMethod = driver?.mfaEnabled === true ? driver.mfaMethod : null;
      if (
        driver == null ||
        !hasMfa({ ...driver, ...factorCounts }) ||
        (code != null && primaryMethod == null)
      ) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }
      // Mirror operator MFA verify: reject MFA completion for drivers
      // deactivated between login and code submission. Otherwise a stale
      // mfaToken JWT could complete and yield a real session for an
      // already-disabled account.
      if (!driver.isActive) {
        await recordAuthAudit(request, {
          kind: 'driver',
          accountId: driver.id,
          action: 'login_failed',
          method: 'mfa',
          reason: 'inactive',
        });
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      const mfaReading = await readMfaConfig();
      const recoveryCodesBefore = factorCounts.recoveryCodesRemaining;
      const gate = mfaMethodGate({ ...driver, ...factorCounts }, mfaReading);
      // A recovery code has no method switch: it works whatever the gate says.
      if (recoveryCode == null && gate === 'refused') {
        await recordAuthAudit(request, {
          kind: 'driver',
          accountId: driver.id,
          action: 'login_failed',
          method: 'mfa',
          reason: 'mfa_method_disabled',
        });
        await reply
          .status(403)
          .send({ error: 'MFA method is disabled', code: 'MFA_METHOD_DISABLED' });
        return;
      }

      let totpSecret: string | null = null;
      if (recoveryCode == null && driver.mfaMethod === 'totp') {
        try {
          totpSecret =
            driver.totpSecretEnc != null
              ? decryptString(driver.totpSecretEnc, apiConfig.SETTINGS_ENCRYPTION_KEY)
              : null;
        } catch (err: unknown) {
          // Corrupted ciphertext or rotated SETTINGS_ENCRYPTION_KEY would
          // crash the request with a raw 500. Return a clean 400 so the
          // driver sees a comprehensible error and root cause is logged.
          request.log.warn({ err, driverId: driver.id }, 'TOTP secret decrypt failed');
        }
        if (totpSecret == null) {
          await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
          return;
        }
      }

      // Per-account backoff after repeated wrong codes, as for operators: the try is counted
      // before the check, in the UPDATE that checks the lock, so parallel guesses cannot pass it.
      const attempt = await takeSignInAttempt({ driverId: driver.id }, 'mfa');
      if (!attempt.granted) {
        const retryAfterSeconds = secondsUntil(attempt.lockedUntil ?? new Date());
        await recordAuthAudit(request, {
          kind: 'driver',
          accountId: driver.id,
          action: 'login_failed',
          method: 'mfa',
          reason: 'locked',
        });
        void reply.header('Retry-After', String(retryAfterSeconds));
        await reply.status(429).send({
          error: 'Too many wrong codes. Try again later.',
          code: 'MFA_LOCKED',
          retryAfterSeconds,
        });
        return;
      }

      let verified = false;
      let exhausted = false;
      let recoveryCodesRemaining: number | undefined;
      if (recoveryCode != null) {
        const result = await consumeRecoveryCode({ driverId: driver.id }, recoveryCode, {
          actor: accountAuditActor({ driverId: driver.id }),
          log: request.log,
        });
        verified = result.used;
        if (result.used) recoveryCodesRemaining = result.remaining;
      } else if (code == null) {
        verified = false;
      } else if (totpSecret != null) {
        const step = matchTotpStep(totpSecret, code);
        // A code is accepted once (replay guard, sign-in-backoff.ts).
        if (step != null) verified = await acceptTotpStep({ driverId: driver.id }, step);
      } else if (challengeId != null) {
        // The tries are counted on the challenge row (single use, at most
        // MFA_CHALLENGE_MAX_ATTEMPTS codes), shared by every API process.
        const result = await verifyMfaChallenge(client, challengeId, code, {
          driverId: driver.id,
          method: driver.mfaMethod ?? '',
          purpose: 'sign_in',
          destination: mfaCodeDestination(driver.mfaMethod, driver),
        });
        verified = result === 'verified';
        exhausted = result === 'exhausted';
      }

      if (!verified) {
        await recordAuthAudit(request, {
          kind: 'driver',
          accountId: driver.id,
          action: 'login_failed',
          method: recoveryCode != null ? 'recovery_code' : 'mfa',
          reason: exhausted ? 'mfa_challenge_exhausted' : 'mfa_code_invalid',
        });
        await recordAttemptFailure(request, attempt);
        if (exhausted) {
          await reply.status(400).send({
            error: 'Too many failed attempts. Request a new code.',
            code: 'MFA_CHALLENGE_EXHAUSTED',
          });
          return;
        }
        await reply
          .status(400)
          .send({ error: 'Invalid verification code', code: 'MFA_CODE_INVALID' });
        return;
      }
      await clearSignInFailures({ driverId: driver.id }, 'mfa');

      // A switched-off method that was the only factor, or the last recovery code of such a
      // driver, leaves no factor: the driver proved the old one and now sets up another.
      const factorsAfter = {
        ...driver,
        ...factorCounts,
        recoveryCodesRemaining: recoveryCodesRemaining ?? recoveryCodesBefore,
      };
      const enrollmentRequired =
        usableFactors(factorsAfter, mfaReading).length === 0 &&
        (mfaMethodGate(factorsAfter, mfaReading) === 'enrollment_required' ||
          passkeyGate(factorsAfter, mfaReading) === 'enrollment_required');
      const enrollment = enrollmentRequired
        ? driverMfaEnrollmentAfterVerify(app, driver, mfaReading.config, {
            mobile: isMobileClient(request),
          })
        : null;
      if (enrollment != null && isDriverMobileMfaUnsupported(enrollment)) {
        await recordAuthAudit(request, {
          kind: 'driver',
          accountId: driver.id,
          action: 'login_failed',
          method: recoveryCode != null ? 'recovery_code' : 'mfa',
          reason: mobileMfaUnsupportedAuditReason(enrollment.mobileMfaUnsupported),
        });
        await sendMobileMfaUnsupported(
          reply,
          enrollment.mobileMfaUnsupported,
          apiConfig.PORTAL_URL,
        );
        return;
      }
      if (enrollment != null) {
        // No session yet: the confirm of the new method signs the driver in.
        return {
          ...enrollment,
          ...(recoveryCodesRemaining != null ? { recoveryCodesRemaining } : {}),
        };
      }

      await recordAuthAudit(request, {
        kind: 'driver',
        accountId: driver.id,
        action: 'login_succeeded',
        method: recoveryCode != null ? 'recovery_code' : 'mfa',
      });
      await issueDriverSession(
        app,
        request,
        reply,
        {
          id: driver.id,
          firstName: driver.firstName,
          lastName: driver.lastName,
          email: driver.email,
          phone: driver.phone,
          language: driver.language,
          timezone: driver.timezone,
          themePreference: driver.themePreference,
          distanceUnit: driver.distanceUnit,
          priceDisplay: driver.priceDisplay,
          isActive: driver.isActive,
          emailVerified: driver.emailVerified,
          createdAt: driver.createdAt,
        },
        { extra: recoveryCodesRemaining != null ? { recoveryCodesRemaining } : {} },
      );
      return;
    },
  );

  // Portal MFA resend
  const mfaResendBody = z.object({
    mfaToken: z.string().min(1),
  });

  app.post(
    '/portal/auth/mfa/resend',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Resend MFA verification code',
        operationId: 'portalResendMfa',
        security: [],
        body: zodSchema(mfaResendBody),
        response: {
          200: itemResponse(z.object({ challengeId: z.number() }).passthrough()),
          400: errorWith('Bad request', [
            ERROR_CODES.MFA_NOT_CONFIGURED,
            ERROR_CODES.MFA_TOKEN_INVALID,
            ERROR_CODES.MFA_TOTP_NO_RESEND,
          ]),
          401: errorWith('Unauthorized', [ERROR_CODES.UNAUTHORIZED, ERROR_CODES.MFA_TOKEN_EXPIRED]),
          403: errorWith('Forbidden', [
            ERROR_CODES.ACCOUNT_DISABLED,
            ERROR_CODES.MFA_METHOD_DISABLED,
          ]),
          429: errorWith('Too many codes sent', [ERROR_CODES.MFA_RESEND_LIMITED]),
        },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const { mfaToken } = request.body as z.infer<typeof mfaResendBody>;

      let payload: { driverId: string; type: string; mfaPending?: boolean };
      try {
        payload = app.jwt.verify(mfaToken);
      } catch (err) {
        request.log.debug({ err }, 'MFA token did not verify, refusing it');
        await reply
          .status(401)
          .send({ error: 'Invalid or expired MFA token', code: 'MFA_TOKEN_EXPIRED' });
        return;
      }

      if (!payload.mfaPending || payload.type !== 'driver') {
        await reply.status(400).send({ error: 'Invalid MFA token', code: 'MFA_TOKEN_INVALID' });
        return;
      }

      const [driver] = await db.select().from(drivers).where(eq(drivers.id, payload.driverId));
      if (driver != null && !mfaPendingTokenCurrent(payload, driver.sessionVersion)) {
        await sendMfaTokenExpired(reply);
        return;
      }
      if (driver == null || !driver.mfaEnabled || driver.mfaMethod == null) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }

      // No code for a driver deactivated after the password step.
      if (!driver.isActive) {
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      if (driver.mfaMethod === 'totp') {
        await reply
          .status(400)
          .send({ error: 'Cannot resend TOTP codes', code: 'MFA_TOTP_NO_RESEND' });
        return;
      }

      if (
        mfaMethodGate(
          { ...driver, ...(await mfaFactorCounts({ driverId: driver.id })) },
          await readMfaConfig(),
        ) === 'refused'
      ) {
        await reply
          .status(403)
          .send({ error: 'MFA method is disabled', code: 'MFA_METHOD_DISABLED' });
        return;
      }

      // A cap on the codes sent to one driver, counted from the challenge rows
      // under a per-account lock so every process sees the same count.
      const challenge = await createAccountMfaChallenge({ driverId: driver.id }, driver.mfaMethod, {
        purpose: 'sign_in',
        destination: mfaCodeDestination(driver.mfaMethod, driver),
        destinationProven: true,
      });
      if (isMfaChallengeLimited(challenge)) {
        await sendMfaResendLimited(reply, challenge.retryAfterSeconds);
        return;
      }

      await dispatchSystemNotification(
        client,
        'mfa.VerificationCode',
        mfaCodeRecipient(driver.mfaMethod, driver),
        { code: challenge.code },
        ALL_TEMPLATES_DIRS,
      );

      return { challengeId: challenge.challengeId };
    },
  );

  // Forgot password
  const forgotPasswordBody = z.object({
    email: z.string().email(),
    recaptchaToken: z.string().optional().describe('reCAPTCHA v3 token'),
  });

  app.post(
    '/portal/auth/forgot-password',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Request a password reset email for a driver account',
        operationId: 'portalForgotPassword',
        security: [],
        body: zodSchema(forgotPasswordBody),
        response: {
          200: successResponse,
          400: errorWith('Bad request', [ERROR_CODES.RECAPTCHA_REQUIRED]),
          403: errorWith('Forbidden', [ERROR_CODES.RECAPTCHA_FAILED]),
        },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const { email, recaptchaToken } = request.body as z.infer<typeof forgotPasswordBody>;

      // Gate reset-link dispatch so a bot cannot enumerate driver emails by
      // triggering reset emails for any account. Native apps cannot produce a
      // reCAPTCHA token; they present a device-attestation token when
      // attestation is enabled, otherwise the endpoint rate limit applies.
      if (isMobileClient(request)) {
        const attested = await verifyDeviceAttestation(request);
        if (!attested) {
          await reply
            .status(403)
            .send({ error: 'Device attestation failed', code: 'ATTESTATION_FAILED' });
          return;
        }
      } else {
        const recaptchaOk = await checkRecaptcha(recaptchaToken, reply);
        if (!recaptchaOk) return;
      }

      // Match register/login path: case-insensitive so a driver who registered with
      // Jane@x.com can recover via jane@x.com. A driver without a password
      // gets no reset email, so knowing their address cannot take over the
      // record. The operator grants first access with a portal invite.
      const [driver] = await db
        .select({
          id: drivers.id,
          firstName: drivers.firstName,
          lastName: drivers.lastName,
          email: drivers.email,
          language: drivers.language,
          phone: drivers.phone,
        })
        .from(drivers)
        .where(
          and(
            emailEquals(drivers.email, email),
            isNotNull(drivers.passwordHash),
            eq(drivers.isActive, true),
          ),
        );

      if (driver != null) {
        // Revoke existing password_reset tokens for this driver
        await db
          .update(userTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(userTokens.driverId, driver.id),
              eq(userTokens.type, 'password_reset'),
              isNull(userTokens.revokedAt),
            ),
          );

        // Generate token
        const { raw: rawToken, hash: tokenHash } = generateUserToken();

        await db.insert(userTokens).values({
          driverId: driver.id,
          tokenHash,
          type: 'password_reset',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });

        // Send email
        const portalUrl = apiConfig.PORTAL_URL;
        const resetUrl = `${portalUrl}/reset-password?token=${rawToken}`;

        // Not awaited: waiting for the mail provider would make the answer
        // for a known email slower than for an unknown one. The response is
        // the same either way, so it does not reveal whether the driver exists.
        // Email only: the request proves control of the email address, not of
        // the phone, and drivers have no verified phone flag. An SMS with the
        // link would hand the reset to whoever holds the stored number.
        void dispatchSystemNotification(
          client,
          'driver.ForgotPassword',
          {
            email: driver.email ?? undefined,
            firstName: driver.firstName,
            language: driver.language,
          },
          {
            firstName: driver.firstName,
            lastName: driver.lastName,
            email: driver.email ?? '',
            resetUrl,
          },
          ALL_TEMPLATES_DIRS,
        ).catch((err: unknown) => {
          request.log.warn(
            { err, driverId: driver.id },
            'Password reset email dispatch failed, answering success anyway',
          );
        });
      }

      return { success: true };
    },
  );

  const activateBody = z.object({
    token: z.string().min(1).describe('Invitation token from the portal invite email link'),
    password: newPasswordSchema,
  });

  app.post(
    '/portal/auth/activate',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Activate driver portal access from an operator invitation',
        description:
          'Sets the first portal password on a driver an operator created, using the single-use token from the invitation email. Marks the email as verified. The driver then signs in through the normal login. Returns 400 INVALID_TOKEN for an unknown, used, replaced, or expired link.',
        operationId: 'portalActivate',
        security: [],
        body: zodSchema(activateBody),
        response: {
          200: successResponse,
          400: errorWith(
            'Invalid invitation or weak password',
            [ERROR_CODES.INVALID_TOKEN, ERROR_CODES.WEAK_PASSWORD],
            weakPasswordFields,
          ),
        },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request) => {
      const { token, password } = request.body as z.infer<typeof activateBody>;
      await activateDriverPortal(token, password, request.log);
      return { success: true as const };
    },
  );

  // Reset password with token
  const resetPasswordBody = z.object({
    token: z.string().min(1),
    password: newPasswordSchema,
    recaptchaToken: z.string().optional().describe('reCAPTCHA v3 token'),
  });

  app.post(
    '/portal/auth/reset-password',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Reset driver password using a token from the reset email',
        operationId: 'portalResetPassword',
        description:
          'Sets a new password with the single-use token from the reset email and revokes every refresh token. Verifies the reCAPTCHA token when enabled (web), or the device attestation (mobile apps).',
        security: [],
        body: zodSchema(resetPasswordBody),
        response: {
          200: successResponse,
          400: errorWith(
            'Bad request',
            [ERROR_CODES.WEAK_PASSWORD, ERROR_CODES.INVALID_TOKEN, ERROR_CODES.RECAPTCHA_REQUIRED],
            weakPasswordFields,
          ),
          403: errorWith('Forbidden', [
            ERROR_CODES.RECAPTCHA_FAILED,
            ERROR_CODES.ATTESTATION_FAILED,
          ]),
        },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const { token, password, recaptchaToken } = request.body as z.infer<typeof resetPasswordBody>;

      const weakPassword = await validatePassword(password);
      if (weakPassword != null) {
        await reply.status(400).send(weakPassword);
        return;
      }

      // Same bot check as login, register and forgot-password: reCAPTCHA on the web, device
      // attestation for the native apps (which cannot produce a reCAPTCHA token).
      if (isMobileClient(request)) {
        const attested = await verifyDeviceAttestation(request);
        if (!attested) {
          await reply
            .status(403)
            .send({ error: 'Device attestation failed', code: 'ATTESTATION_FAILED' });
          return;
        }
      } else {
        const recaptchaOk = await checkRecaptcha(recaptchaToken, reply);
        if (!recaptchaOk) return;
      }

      // Hashed before the token lookup so a valid and an invalid token take
      // the same time.
      const passwordHash = await argon2.hash(password);
      const now = new Date();

      const driverId = await db.transaction(async (tx) => {
        // Consuming the token in the WHERE makes it single-use under
        // concurrency: of two requests with the same link, one wins.
        const [consumed] = await tx
          .update(userTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(userTokens.tokenHash, hashUserToken(token)),
              eq(userTokens.type, 'password_reset'),
              isNull(userTokens.revokedAt),
              gt(userTokens.expiresAt, now),
              isNotNull(userTokens.driverId),
            ),
          )
          .returning({ driverId: userTokens.driverId });
        if (consumed?.driverId == null) return null;

        // A driver deactivated after the link went out gets the same answer
        // as a bad link. The link proves the mailbox, so the email counts as
        // verified.
        const [updated] = await tx
          .update(drivers)
          .set({
            passwordHash,
            emailVerified: true,
            failedLoginCount: 0,
            loginLockedUntil: null,
            updatedAt: now,
          })
          .where(and(eq(drivers.id, consumed.driverId), eq(drivers.isActive, true)))
          .returning({ id: drivers.id });
        // The link stays used: it was valid, the account is not.
        return updated?.id ?? null;
      });

      if (driverId == null) {
        await reply
          .status(400)
          .send({ error: 'Invalid or expired reset link', code: 'INVALID_TOKEN' });
        return;
      }

      // Forgot-password is the recovery path after credential compromise.
      // End every session so an attacker holding a stolen access token or
      // portal_refresh cookie cannot keep using the account after the
      // legitimate driver completes the reset.
      await endDriverSessions(driverId);

      await recordAuthAudit(request, {
        kind: 'driver',
        accountId: driverId,
        action: 'password_reset',
        method: 'reset_token',
      });

      return { success: true };
    },
  );

  // Verify email with token
  const verifyEmailBody = z.object({
    token: z.string().min(1),
  });

  app.post(
    '/portal/auth/verify-email',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Verify driver email address using a token from the verification email',
        operationId: 'portalVerifyEmail',
        security: [],
        body: zodSchema(verifyEmailBody),
        response: {
          200: successResponse,
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const { token } = request.body as z.infer<typeof verifyEmailBody>;

      const now = new Date();
      // Consuming the token in the WHERE makes it single-use: a double click
      // verifies once and sends one welcome email.
      const [tokenRow] = await db
        .update(userTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(userTokens.tokenHash, hashUserToken(token)),
            eq(userTokens.type, 'email_verification'),
            isNull(userTokens.revokedAt),
            gt(userTokens.expiresAt, now),
            isNotNull(userTokens.driverId),
          ),
        )
        .returning({ driverId: userTokens.driverId });

      if (tokenRow?.driverId == null) {
        await reply
          .status(400)
          .send({ error: 'Invalid or expired verification link', code: 'INVALID_TOKEN' });
        return;
      }

      await db
        .update(drivers)
        .set({ emailVerified: true, updatedAt: now })
        .where(eq(drivers.id, tokenRow.driverId));

      await recordAuthAudit(request, {
        kind: 'driver',
        accountId: tokenRow.driverId,
        action: 'email_verified',
        method: 'verification_token',
      });

      // Send the welcome email now that the driver is verified
      const [driver] = await db
        .select({
          id: drivers.id,
          firstName: drivers.firstName,
          lastName: drivers.lastName,
          email: drivers.email,
        })
        .from(drivers)
        .where(eq(drivers.id, tokenRow.driverId));

      if (driver != null) {
        void dispatchDriverNotification(
          client,
          'driver.Welcome',
          driver.id,
          {
            firstName: driver.firstName,
            lastName: driver.lastName,
            email: driver.email,
          },
          ALL_TEMPLATES_DIRS,
          getPubSub(),
        );
      }

      return { success: true };
    },
  );

  // Resend verification email
  app.post(
    '/portal/auth/resend-verification',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Auth'],
        summary: 'Resend email verification link',
        description:
          'Revokes the open verification link and emails a new one (email only, never SMS). Besides the per-IP rate limit, a driver gets at most one verification email a minute and five in 24 hours, the sign-up email included. Over the limit it returns 429 VERIFICATION_RESEND_LIMITED with a Retry-After header and retryAfterSeconds in the body.',
        operationId: 'portalResendVerification',
        security: [{ bearerAuth: [] }],
        response: {
          200: successResponse,
          400: errorWith('Bad request', [
            ERROR_CODES.ALREADY_VERIFIED,
            ERROR_CODES.DRIVER_NOT_FOUND,
          ]),
          429: errorWith('Too many verification emails', [ERROR_CODES.VERIFICATION_RESEND_LIMITED]),
        },
      },
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;

      const [driver] = await db
        .select({
          id: drivers.id,
          firstName: drivers.firstName,
          lastName: drivers.lastName,
          email: drivers.email,
          language: drivers.language,
          emailVerified: drivers.emailVerified,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      if (driver == null) {
        await reply.status(400).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      if (driver.emailVerified) {
        await reply.status(400).send({ error: 'Email already verified', code: 'ALREADY_VERIFIED' });
        return;
      }

      // Per-account cap on top of the per-IP rate limit: one email a minute, five a day.
      const retryAfterSeconds = await verificationResendRetryAfter(driverId);
      if (retryAfterSeconds != null) {
        await reply.header('Retry-After', String(retryAfterSeconds)).status(429).send({
          error: 'Too many verification emails. Wait before you request another one.',
          code: 'VERIFICATION_RESEND_LIMITED',
          retryAfterSeconds,
        });
        return;
      }

      if (driver.email != null) {
        await sendDriverEmailVerification({ ...driver, email: driver.email }, request.log);
      }

      return { success: true };
    },
  );
}
