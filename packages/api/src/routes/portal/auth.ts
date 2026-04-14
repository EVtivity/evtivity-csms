// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import argon2 from 'argon2';
import { db, client, getRecaptchaConfig } from '@evtivity/database';
import { drivers, userTokens } from '@evtivity/database';
import {
  dispatchDriverNotification,
  dispatchSystemNotification,
  verifyRecaptcha,
  decryptString,
  createMfaChallenge,
  verifyMfaChallenge,
  verifyTotpCode,
} from '@evtivity/lib';
import { zodSchema } from '../../lib/zod-schema.js';
import { validatePasswordComplexity } from '../../lib/password-validation.js';
import { ALL_TEMPLATES_DIRS } from '../../lib/template-dirs.js';
import { getPubSub } from '../../lib/pubsub.js';
import { errorResponse, itemResponse, successResponse } from '../../lib/response-schemas.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import {
  createRefreshToken,
  validateAndRotateRefreshToken,
  revokeRefreshToken,
} from '../../services/refresh-token.service.js';
import { config as apiConfig } from '../../lib/config.js';
import {
  isMfaChallengeExhausted,
  recordMfaChallengeAttempt,
  clearMfaChallengeAttempts,
} from '../../lib/rate-limiters.js';

const portalDriverItem = z
  .object({
    id: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    language: z.string().nullable(),
    timezone: z.string().nullable(),
    themePreference: z.string(),
    distanceUnit: z.string(),
    isActive: z.boolean(),
    emailVerified: z.boolean(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const portalAuthRegisterResponse = z.object({ driver: portalDriverItem }).passthrough();

const portalAuthLoginResponse = z
  .object({
    driver: portalDriverItem.optional(),
    mfaRequired: z.boolean().optional(),
    mfaMethod: z.string().optional(),
    mfaToken: z.string().optional(),
    challengeId: z.number().optional(),
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

const ACCESS_COOKIE_MAX_AGE = 60 * 60; // 1 hour in seconds
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

function isSecureRequest(request: FastifyRequest): boolean {
  const proto = request.headers['x-forwarded-proto'];
  if (typeof proto === 'string') {
    return proto.split(',')[0]?.trim() === 'https';
  }
  return request.protocol === 'https';
}

function setAuthCookies(
  reply: FastifyReply,
  accessToken: string,
  refreshToken: string,
  secure: boolean,
): void {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const domainOpts = apiConfig.COOKIE_DOMAIN != null ? { domain: apiConfig.COOKIE_DOMAIN } : {};

  void reply.setCookie('portal_token', accessToken, {
    httpOnly: true,
    secure,
    signed: true,
    sameSite: 'lax',
    path: '/v1/portal',
    maxAge: ACCESS_COOKIE_MAX_AGE,
    ...domainOpts,
  });

  void reply.setCookie('portal_refresh', refreshToken, {
    httpOnly: true,
    secure,
    signed: true,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_COOKIE_MAX_AGE,
    ...domainOpts,
  });

  void reply.setCookie('portal_csrf', csrfToken, {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_COOKIE_MAX_AGE,
    ...domainOpts,
  });
}

function clearAuthCookies(reply: FastifyReply, secure: boolean): void {
  const domainOpts = apiConfig.COOKIE_DOMAIN != null ? { domain: apiConfig.COOKIE_DOMAIN } : {};

  void reply.clearCookie('portal_token', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/v1/portal',
    ...domainOpts,
  });

  void reply.clearCookie('portal_refresh', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    ...domainOpts,
  });

  void reply.clearCookie('portal_csrf', {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    ...domainOpts,
  });
}

async function checkRecaptcha(token: string | undefined, reply: FastifyReply): Promise<boolean> {
  const config = await getRecaptchaConfig();
  if (config == null) return true;
  if (token == null || token === '') {
    await reply
      .status(400)
      .send({ error: 'reCAPTCHA token is required', code: 'RECAPTCHA_REQUIRED' });
    return false;
  }
  const encryptionKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
  const secretKey = decryptString(config.secretKeyEnc, encryptionKey);
  const result = await verifyRecaptcha(token, secretKey, config.threshold);
  if (!result.success) {
    await reply
      .status(403)
      .send({ error: 'reCAPTCHA verification failed', code: 'RECAPTCHA_FAILED' });
    return false;
  }
  return true;
}

export function portalAuthRoutes(app: FastifyInstance): void {
  app.post(
    '/portal/auth/register',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Register a new driver account',
        operationId: 'portalRegister',
        security: [],
        body: zodSchema(registerBody),
        response: {
          201: itemResponse(portalAuthRegisterResponse),
          400: errorResponse,
          403: errorResponse,
          409: errorResponse,
          500: errorResponse,
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

      const complexityError = validatePasswordComplexity(body.password);
      if (complexityError != null) {
        await reply.status(400).send({ error: complexityError, code: 'WEAK_PASSWORD' });
        return;
      }

      const recaptchaOk = await checkRecaptcha(body.recaptchaToken, reply);
      if (!recaptchaOk) return;

      const [existing] = await db
        .select({ id: drivers.id })
        .from(drivers)
        .where(eq(drivers.email, body.email));

      if (existing != null) {
        await reply.status(409).send({ error: 'Email already registered', code: 'EMAIL_EXISTS' });
        return;
      }

      const passwordHash = await argon2.hash(body.password);

      const rows = await db
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

      const driver = rows[0];
      if (driver == null) {
        await reply.status(500).send({ error: 'Failed to create driver' });
        return;
      }
      const token = app.jwt.sign(
        { driverId: driver.id, type: 'driver' } satisfies DriverJwtPayload,
        { expiresIn: '1h' },
      );
      const refreshResult = await createRefreshToken({ driverId: driver.id });

      setAuthCookies(reply, token, refreshResult.rawToken, isSecureRequest(request));
      await reply.status(201).send({ driver });

      // Generate email verification token
      const rawVerifyToken = crypto.randomBytes(32).toString('hex');
      const verifyTokenHash = crypto.createHash('sha256').update(rawVerifyToken).digest('hex');

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
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
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

      const recaptchaOk = await checkRecaptcha(recaptchaToken, reply);
      if (!recaptchaOk) return;

      const [driver] = await db
        .select()
        .from(drivers)
        .where(
          and(
            eq(drivers.email, email),
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

      const token = app.jwt.sign(
        { driverId: driver.id, type: 'driver' } satisfies DriverJwtPayload,
        { expiresIn: '1h' },
      );
      const refreshResult = await createRefreshToken({ driverId: driver.id });

      setAuthCookies(reply, token, refreshResult.rawToken, isSecureRequest(request));

      return {
        driver: {
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
        },
      };
    },
  );

  app.post(
    '/portal/auth/logout',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Auth'],
        summary: 'Log out and clear auth cookies',
        operationId: 'portalLogout',
        security: [{ bearerAuth: [] }],
        response: { 204: { type: 'null' as const } },
      },
    },
    async (request, reply) => {
      const rawRefreshToken = request.cookies['portal_refresh'];
      if (rawRefreshToken) {
        await revokeRefreshToken(rawRefreshToken);
      }
      clearAuthCookies(reply, isSecureRequest(request));
      await reply.status(204).send();
    },
  );

  app.post(
    '/portal/auth/refresh',
    {
      schema: {
        tags: ['Portal Auth'],
        summary: 'Refresh access token using refresh token cookie',
        operationId: 'portalRefreshToken',
        security: [],
        response: { 200: successResponse, 401: errorResponse },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const rawToken = request.cookies['portal_refresh'];
      if (!rawToken) {
        await reply.status(401).send({ error: 'No refresh token', code: 'NO_REFRESH_TOKEN' });
        return;
      }

      const result = await validateAndRotateRefreshToken(rawToken);
      if (result == null || result.driverId == null) {
        clearAuthCookies(reply, isSecureRequest(request));
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
        clearAuthCookies(reply, isSecureRequest(request));
        await reply.status(401).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      const accessToken = app.jwt.sign(
        { driverId: driver.id, type: 'driver' } satisfies DriverJwtPayload,
        { expiresIn: '1h' },
      );
      const newRefresh = await createRefreshToken({ driverId: driver.id });
      setAuthCookies(reply, accessToken, newRefresh.rawToken, isSecureRequest(request));

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
        response: { 200: itemResponse(portalDriverItem), 404: errorResponse },
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
        operationId: 'portalVerifyMfa',
        security: [],
        body: zodSchema(mfaVerifyBody),
        response: {
          200: itemResponse(portalMfaLoginResponse),
          400: errorResponse,
          401: errorResponse,
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
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

      let verified = false;
      if (driver.mfaMethod === 'totp') {
        if (driver.totpSecretEnc == null) {
          await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
          return;
        }
        const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
        const secret = decryptString(driver.totpSecretEnc, encKey);
        verified = verifyTotpCode(secret, code);
      } else if (challengeId != null) {
        verified = await verifyMfaChallenge(client, challengeId, code);
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

      const token = app.jwt.sign(
        { driverId: driver.id, type: 'driver' } satisfies DriverJwtPayload,
        { expiresIn: '1h' },
      );
      const refreshResult = await createRefreshToken({ driverId: driver.id });

      setAuthCookies(reply, token, refreshResult.rawToken, isSecureRequest(request));

      return {
        driver: {
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
        },
      };
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
          400: errorResponse,
          401: errorResponse,
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
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
        response: { 200: successResponse },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request) => {
      const { email } = request.body as z.infer<typeof forgotPasswordBody>;

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
            eq(drivers.email, email),
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
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

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
        response: { 200: successResponse, 400: errorResponse },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { token, password } = request.body as z.infer<typeof resetPasswordBody>;

      const complexityError = validatePasswordComplexity(password);
      if (complexityError != null) {
        await reply.status(400).send({ error: complexityError, code: 'WEAK_PASSWORD' });
        return;
      }

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

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
        response: { 200: successResponse, 400: errorResponse },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { token } = request.body as z.infer<typeof verifyEmailBody>;

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

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
        response: { 200: successResponse, 400: errorResponse },
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
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

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
