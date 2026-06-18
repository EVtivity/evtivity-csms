// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, isNull, ilike } from 'drizzle-orm';
import argon2 from 'argon2';
import { db, client, isPortalRegistrationEnabled } from '@evtivity/database';
import { drivers, userTokens } from '@evtivity/database';
import {
  dispatchDriverNotification,
  dispatchSystemNotification,
  decryptString,
  createMfaChallenge,
  verifyMfaChallenge,
  verifyTotpCode,
} from '@evtivity/lib';
import { setAuthCookies, clearAuthCookies, isSecureRequest } from '../../lib/auth-cookies.js';
import { zodSchema } from '../../lib/zod-schema.js';
import { generateUserToken, hashUserToken } from '../../lib/user-token.js';
import { validatePasswordComplexity } from '../../lib/password-validation.js';
import { ALL_TEMPLATES_DIRS } from '../../lib/template-dirs.js';
import { getPubSub } from '../../lib/pubsub.js';
import { itemResponse, successResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import { checkRecaptcha } from '../../lib/recaptcha-check.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import {
  createRefreshToken,
  validateAndRotateRefreshToken,
  revokeRefreshToken,
  revokeAllDriverRefreshTokens,
} from '../../services/refresh-token.service.js';
import { config as apiConfig } from '../../lib/config.js';
import {
  issueDriverSession,
  isMobileClient,
  deviceIdFromRequest,
} from '../../lib/driver-session.js';
import {
  isMfaChallengeExhausted,
  recordMfaChallengeAttempt,
  clearMfaChallengeAttempts,
} from '../../lib/rate-limiters.js';

const portalDriverItem = z
  .object({
    id: z.string(),
    firstName: z.string().max(100).nullable(),
    lastName: z.string().max(100).nullable(),
    email: z.string().email().max(255).nullable(),
    phone: z.string().max(50).nullable(),
    language: z.string().max(10).nullable(),
    timezone: z.string().max(50).nullable(),
    themePreference: z.enum(['light', 'dark']),
    distanceUnit: z.enum(['miles', 'km']),
    isActive: z.boolean(),
    emailVerified: z.boolean(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

// Mobile clients (X-Client: mobile) receive these in the body instead of cookies.
const mobileSessionFields = {
  token: z.string().optional().describe('Access JWT, mobile clients only'),
  refreshToken: z.string().optional().describe('Opaque refresh token, mobile clients only'),
  expiresIn: z.number().int().optional().describe('Access token lifetime in seconds'),
};

const portalAuthRegisterResponse = z
  .object({ driver: portalDriverItem, ...mobileSessionFields })
  .passthrough();

const portalAuthLoginResponse = z
  .object({
    driver: portalDriverItem.optional(),
    mfaRequired: z.boolean().optional(),
    mfaMethod: z.enum(['email', 'sms', 'totp']).optional(),
    mfaToken: z.string().optional(),
    challengeId: z.number().int().min(1).optional(),
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
  email: z.string().email(),
  password: z.string().min(12),
  phone: z.string().max(50).optional(),
  recaptchaToken: z.string().optional().describe('reCAPTCHA v3 token'),
});

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  recaptchaToken: z.string().optional().describe('reCAPTCHA v3 token'),
});

const driverSelect = {
  id: drivers.id,
  firstName: drivers.firstName,
  lastName: drivers.lastName,
  email: drivers.email,
  phone: drivers.phone,
  language: drivers.language,
  timezone: drivers.timezone,
  themePreference: drivers.themePreference,
  distanceUnit: drivers.distanceUnit,
  isActive: drivers.isActive,
  emailVerified: drivers.emailVerified,
  createdAt: drivers.createdAt,
};

export function portalAuthRoutes(app: FastifyInstance): void {
  app.post(
    '/portal/auth/register',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Register a new driver account',
        description:
          'Creates a driver row with registrationSource=portal, hashes the password with argon2, sends a verification email, and sets portal session and refresh cookies. Verifies the reCAPTCHA token when enabled. Returns 409 on duplicate email and 403 if portal registration is disabled by settings.',
        operationId: 'portalRegister',
        security: [],
        body: zodSchema(registerBody),
        response: {
          201: itemResponse(portalAuthRegisterResponse),
          400: errorWith('Weak password', [ERROR_CODES.WEAK_PASSWORD]),
          403: errorWith('Forbidden', [ERROR_CODES.PORTAL_REGISTRATION_DISABLED]),
          409: errorWith('Email exists', [ERROR_CODES.EMAIL_EXISTS]),
          500: errorWith('Internal server error', [ERROR_CODES.INTERNAL_ERROR]),
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

      const complexityError = validatePasswordComplexity(body.password);
      if (complexityError != null) {
        await reply.status(400).send({ error: complexityError, code: 'WEAK_PASSWORD' });
        return;
      }

      // Native apps cannot produce a reCAPTCHA token; mobile relies on the
      // endpoint rate limit instead.
      if (!isMobileClient(request)) {
        const recaptchaOk = await checkRecaptcha(body.recaptchaToken, reply);
        if (!recaptchaOk) return;
      }

      // Use ilike so jane@x.com cannot register again as Jane@x.com.
      const [existing] = await db
        .select({ id: drivers.id })
        .from(drivers)
        .where(ilike(drivers.email, body.email));

      if (existing != null) {
        await reply.status(409).send({ error: 'Email already registered', code: 'EMAIL_EXISTS' });
        return;
      }

      const passwordHash = await argon2.hash(body.password);

      let rows;
      try {
        rows = await db
          .insert(drivers)
          .values({
            firstName: body.firstName,
            lastName: body.lastName,
            email: body.email,
            phone: body.phone,
            passwordHash,
            registrationSource: 'portal',
          })
          .returning(driverSelect);
      } catch (err) {
        // The application-level ilike check above is non-transactional, so two
        // concurrent registrations with the same email both reach this INSERT.
        // The partial unique index on LOWER(email) (migration 0052) makes the
        // loser 23505; map it back to 409 EMAIL_EXISTS instead of leaking 500.
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === '23505'
        ) {
          await reply.status(409).send({ error: 'Email already registered', code: 'EMAIL_EXISTS' });
          return;
        }
        throw err;
      }

      const driver = rows[0];
      if (driver == null) {
        await reply
          .status(500)
          .send({ error: 'Failed to create driver', code: 'DRIVER_CREATE_FAILED' });
        return;
      }
      await issueDriverSession(app, request, reply, driver, { status: 201 });

      // Generate email verification token
      const { raw: rawVerifyToken, hash: verifyTokenHash } = generateUserToken();

      await db.insert(userTokens).values({
        driverId: driver.id,
        tokenHash: verifyTokenHash,
        type: 'email_verification',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const portalUrl = apiConfig.PORTAL_URL;
      const verifyUrl = `${portalUrl}/verify-email?token=${rawVerifyToken}`;

      void dispatchSystemNotification(
        client,
        'driver.AccountVerification',
        {
          email: driver.email ?? undefined,
          phone: driver.phone ?? undefined,
          firstName: driver.firstName,
          language: driver.language,
        },
        {
          firstName: driver.firstName,
          lastName: driver.lastName,
          email: driver.email ?? '',
          verifyUrl,
        },
        ALL_TEMPLATES_DIRS,
      );
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
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN, ERROR_CODES.RECAPTCHA_FAILED]),
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
      // token, so mobile clients skip it and rely on the per-endpoint rate
      // limit. The X-Client header is spoofable, so this trades the reCAPTCHA
      // bot layer for rate limiting on the mobile path. checkRecaptcha is a
      // no-op when reCAPTCHA is disabled, so web is unaffected on those
      // deployments.
      if (!isMobileClient(request)) {
        const recaptchaOk = await checkRecaptcha(recaptchaToken, reply);
        if (!recaptchaOk) return;
      }

      // Use ilike so a driver who registered as Jane@x.com can log in
      // typing jane@x.com. The register path already uses ilike for the
      // duplicate check, so login must match for the round-trip to work.
      const [driver] = await db
        .select()
        .from(drivers)
        .where(
          and(
            ilike(drivers.email, email),
            eq(drivers.registrationSource, 'portal'),
            eq(drivers.isActive, true),
          ),
        );

      if (driver == null || driver.passwordHash == null) {
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }

      const valid = await argon2.verify(driver.passwordHash, password);
      if (!valid) {
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }

      // MFA check
      if (driver.mfaEnabled && driver.mfaMethod != null) {
        const mfaToken = app.jwt.sign(
          { driverId: driver.id, type: 'driver', mfaPending: true } as unknown as DriverJwtPayload,
          { expiresIn: '3m' },
        );

        let challengeId: number | undefined;
        if (driver.mfaMethod === 'email' || driver.mfaMethod === 'sms') {
          const challenge = await createMfaChallenge(client, {
            driverId: driver.id,
            method: driver.mfaMethod,
          });
          challengeId = challenge.challengeId;

          await dispatchSystemNotification(
            client,
            'mfa.VerificationCode',
            {
              email: driver.email ?? undefined,
              phone: driver.phone ?? undefined,
              firstName: driver.firstName,
              language: driver.language,
            },
            { code: challenge.code },
            ALL_TEMPLATES_DIRS,
          );
        }

        return {
          mfaRequired: true,
          mfaMethod: driver.mfaMethod,
          mfaToken,
          challengeId,
        };
      }

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
          'Revokes the refresh token and clears auth cookies. Web clients use the portal_refresh cookie; mobile clients (X-Client: mobile) send { refreshToken } in the body to revoke it server-side.',
        operationId: 'portalLogout',
        security: [{ bearerAuth: [] }],
        response: { 204: { type: 'null' as const } },
      },
    },
    async (request, reply) => {
      const mobile = isMobileClient(request);
      const rawRefreshToken = mobile
        ? (request.body as { refreshToken?: string } | undefined)?.refreshToken
        : request.cookies['portal_refresh'];
      if (rawRefreshToken) {
        await revokeRefreshToken(rawRefreshToken);
      }
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
          'Rotates the refresh token and issues a new access token. Web clients use the portal_refresh cookie and receive new cookies. Mobile clients (X-Client: mobile) send { refreshToken } in the body and receive { token, refreshToken, expiresIn }; the token is device-bound via X-Device-Id. Rate limited to 30/min. Returns 401 if the token is missing, invalid, expired, revoked, the device does not match, or the driver is deactivated.',
        operationId: 'portalRefreshToken',
        security: [],
        response: {
          200: zodSchema(portalRefreshResponse),
          401: errorWith('Unauthorized', [
            ERROR_CODES.ACCOUNT_DISABLED,
            ERROR_CODES.NO_REFRESH_TOKEN,
            ERROR_CODES.INVALID_REFRESH_TOKEN,
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
      const mobile = isMobileClient(request);
      const deviceId = mobile ? deviceIdFromRequest(request) : undefined;
      const rawToken = mobile
        ? (request.body as { refreshToken?: string } | undefined)?.refreshToken
        : request.cookies['portal_refresh'];
      if (!rawToken) {
        await reply.status(401).send({ error: 'No refresh token', code: 'NO_REFRESH_TOKEN' });
        return;
      }

      const result = await validateAndRotateRefreshToken(rawToken, { deviceId });
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

      const accessToken = app.jwt.sign(
        { driverId: driver.id, type: 'driver' } satisfies DriverJwtPayload,
        { expiresIn: '1h' },
      );
      const newRefresh = await createRefreshToken({ driverId: driver.id, deviceId });

      if (mobile) {
        return { token: accessToken, refreshToken: newRefresh.rawToken, expiresIn: 3600 };
      }
      setAuthCookies('portal', reply, accessToken, newRefresh.rawToken, isSecureRequest(request));
      return { success: true };
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
          200: itemResponse(portalDriverItem),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;

      const [driver] = await db.select(driverSelect).from(drivers).where(eq(drivers.id, driverId));

      if (driver == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      return driver;
    },
  );

  // Portal MFA verify
  const mfaVerifyBody = z.object({
    mfaToken: z.string().min(1),
    code: z.string().min(6).max(6),
    challengeId: z.coerce.number().int().min(1).optional(),
  });

  const portalMfaLoginResponse = z.object({ driver: portalDriverItem }).passthrough();

  app.post(
    '/portal/auth/mfa/verify',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Verify MFA code and complete portal login',
        description:
          'Validates the short-lived MFA pending JWT, verifies the supplied TOTP code or email/SMS challenge code, and on success sets portal session and refresh cookies. Codes expire after 5 minutes and are single-use. Returns 401 on invalid code or expired pending JWT.',
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
          ]),
          401: errorWith('Unauthorized', [ERROR_CODES.UNAUTHORIZED, ERROR_CODES.MFA_TOKEN_EXPIRED]),
          403: errorWith('Account disabled', [ERROR_CODES.ACCOUNT_DISABLED]),
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
      const { mfaToken, code, challengeId } = request.body as z.infer<typeof mfaVerifyBody>;

      let payload: { driverId: string; type: string; mfaPending?: boolean };
      try {
        payload = app.jwt.verify(mfaToken);
      } catch {
        await reply
          .status(401)
          .send({ error: 'Invalid or expired MFA token', code: 'MFA_TOKEN_EXPIRED' });
        return;
      }

      if (!payload.mfaPending || payload.type !== 'driver') {
        await reply.status(400).send({ error: 'Invalid MFA token', code: 'MFA_TOKEN_INVALID' });
        return;
      }

      // Per-challengeId brute-force protection
      if (challengeId != null && isMfaChallengeExhausted(challengeId)) {
        await reply.status(400).send({
          error: 'Too many failed attempts. Request a new code.',
          code: 'MFA_CHALLENGE_EXHAUSTED',
        });
        return;
      }

      const [driver] = await db.select().from(drivers).where(eq(drivers.id, payload.driverId));
      if (driver == null || !driver.mfaEnabled || driver.mfaMethod == null) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }
      // Mirror operator MFA verify: reject MFA completion for drivers
      // deactivated between login and code submission. Otherwise a stale
      // mfaToken JWT could complete and yield a real session for an
      // already-disabled account.
      if (!driver.isActive) {
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      let verified = false;
      if (driver.mfaMethod === 'totp') {
        if (driver.totpSecretEnc == null) {
          await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
          return;
        }
        const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
        try {
          const secret = decryptString(driver.totpSecretEnc, encKey);
          verified = verifyTotpCode(secret, code);
        } catch (err: unknown) {
          // Corrupted ciphertext or rotated SETTINGS_ENCRYPTION_KEY would
          // crash the request with a raw 500. Return a clean 400 so the
          // driver sees a comprehensible error and root cause is logged.
          request.log.warn({ err, driverId: driver.id }, 'TOTP secret decrypt failed');
          await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
          return;
        }
      } else if (challengeId != null) {
        verified = await verifyMfaChallenge(client, challengeId, code, { driverId: driver.id });
      }

      if (!verified) {
        if (challengeId != null) {
          recordMfaChallengeAttempt(challengeId);
        }
        await reply
          .status(400)
          .send({ error: 'Invalid verification code', code: 'MFA_CODE_INVALID' });
        return;
      }

      // Clear attempt counter on success
      if (challengeId != null) {
        clearMfaChallengeAttempts(challengeId);
      }

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
        isActive: driver.isActive,
        emailVerified: driver.emailVerified,
        createdAt: driver.createdAt,
      });
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
      } catch {
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
      if (driver == null || !driver.mfaEnabled || driver.mfaMethod == null) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }

      if (driver.mfaMethod === 'totp') {
        await reply
          .status(400)
          .send({ error: 'Cannot resend TOTP codes', code: 'MFA_TOTP_NO_RESEND' });
        return;
      }

      const challenge = await createMfaChallenge(client, {
        driverId: driver.id,
        method: driver.mfaMethod,
      });

      await dispatchSystemNotification(
        client,
        'mfa.VerificationCode',
        {
          email: driver.email ?? undefined,
          phone: driver.phone ?? undefined,
          firstName: driver.firstName,
          language: driver.language,
        },
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

      // Gate reset-link dispatch on reCAPTCHA so a bot cannot enumerate
      // driver emails by triggering reset emails for any account. Native apps
      // cannot produce a token, so mobile relies on the endpoint rate limit.
      if (!isMobileClient(request)) {
        const recaptchaOk = await checkRecaptcha(recaptchaToken, reply);
        if (!recaptchaOk) return;
      }

      // Match register/login path: ilike so a driver who registered with
      // Jane@x.com can recover via jane@x.com.
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
            ilike(drivers.email, email),
            eq(drivers.registrationSource, 'portal'),
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

        try {
          await dispatchSystemNotification(
            client,
            'driver.ForgotPassword',
            {
              email: driver.email ?? undefined,
              phone: driver.phone ?? undefined,
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
          );
        } catch {
          // Silently fail to not leak driver existence
        }
      }

      return { success: true };
    },
  );

  // Reset password with token
  const resetPasswordBody = z.object({
    token: z.string().min(1),
    password: z.string().min(12),
  });

  app.post(
    '/portal/auth/reset-password',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Reset driver password using a token from the reset email',
        operationId: 'portalResetPassword',
        security: [],
        body: zodSchema(resetPasswordBody),
        response: {
          200: successResponse,
          400: errorWith('Weak password', [ERROR_CODES.WEAK_PASSWORD]),
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
      const { token, password } = request.body as z.infer<typeof resetPasswordBody>;

      const complexityError = validatePasswordComplexity(password);
      if (complexityError != null) {
        await reply.status(400).send({ error: complexityError, code: 'WEAK_PASSWORD' });
        return;
      }

      const tokenHash = hashUserToken(token);

      const [tokenRow] = await db
        .select({
          id: userTokens.id,
          driverId: userTokens.driverId,
          expiresAt: userTokens.expiresAt,
        })
        .from(userTokens)
        .where(
          and(
            eq(userTokens.tokenHash, tokenHash),
            eq(userTokens.type, 'password_reset'),
            isNull(userTokens.revokedAt),
          ),
        );

      if (tokenRow == null || tokenRow.driverId == null || tokenRow.expiresAt < new Date()) {
        await reply
          .status(400)
          .send({ error: 'Invalid or expired reset link', code: 'INVALID_TOKEN' });
        return;
      }

      const passwordHash = await argon2.hash(password);

      await db
        .update(drivers)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(drivers.id, tokenRow.driverId));

      await db
        .update(userTokens)
        .set({ revokedAt: new Date() })
        .where(eq(userTokens.id, tokenRow.id));

      // Forgot-password is the recovery path after credential compromise.
      // Revoke every outstanding refresh token so an attacker holding a
      // stolen portal_refresh cookie cannot keep using the account after
      // the legitimate driver completes the reset.
      await revokeAllDriverRefreshTokens(tokenRow.driverId);

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

      const tokenHash = hashUserToken(token);

      const [tokenRow] = await db
        .select({
          id: userTokens.id,
          driverId: userTokens.driverId,
          expiresAt: userTokens.expiresAt,
        })
        .from(userTokens)
        .where(
          and(
            eq(userTokens.tokenHash, tokenHash),
            eq(userTokens.type, 'email_verification'),
            isNull(userTokens.revokedAt),
          ),
        );

      if (tokenRow == null || tokenRow.driverId == null || tokenRow.expiresAt < new Date()) {
        await reply
          .status(400)
          .send({ error: 'Invalid or expired verification link', code: 'INVALID_TOKEN' });
        return;
      }

      await db
        .update(drivers)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(eq(drivers.id, tokenRow.driverId));

      await db
        .update(userTokens)
        .set({ revokedAt: new Date() })
        .where(eq(userTokens.id, tokenRow.id));

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
        operationId: 'portalResendVerification',
        security: [{ bearerAuth: [] }],
        response: {
          200: successResponse,
          400: errorWith('Bad request', [
            ERROR_CODES.ALREADY_VERIFIED,
            ERROR_CODES.DRIVER_NOT_FOUND,
          ]),
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
          phone: drivers.phone,
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

      // Revoke existing email_verification tokens
      await db
        .update(userTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(userTokens.driverId, driverId),
            eq(userTokens.type, 'email_verification'),
            isNull(userTokens.revokedAt),
          ),
        );

      // Generate new token
      const { raw: rawToken, hash: tokenHash } = generateUserToken();

      await db.insert(userTokens).values({
        driverId,
        tokenHash,
        type: 'email_verification',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const portalUrl = apiConfig.PORTAL_URL;
      const verifyUrl = `${portalUrl}/verify-email?token=${rawToken}`;

      void dispatchSystemNotification(
        client,
        'driver.AccountVerification',
        {
          email: driver.email ?? undefined,
          phone: driver.phone ?? undefined,
          firstName: driver.firstName,
          language: driver.language,
        },
        {
          firstName: driver.firstName,
          lastName: driver.lastName,
          email: driver.email ?? '',
          verifyUrl,
        },
        ALL_TEMPLATES_DIRS,
      );

      return { success: true };
    },
  );
}
