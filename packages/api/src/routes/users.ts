// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import crypto from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { eq, and, or, isNull, ilike, sql, inArray } from 'drizzle-orm';
import argon2 from 'argon2';
import {
  db,
  client,
  getRecaptchaConfig,
  getMfaConfig,
  writeAudit,
  userAuditLog,
} from '@evtivity/database';
import {
  users,
  roles,
  sites,
  userTokens,
  userSiteAssignments,
  userNotificationPreferences,
  chatbotAiConfigs,
  userPermissions,
} from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import {
  getNotificationSettings,
  sendEmail,
  wrapEmailHtml,
  renderTemplate,
  dispatchSystemNotification,
  verifyRecaptcha,
  decryptString,
  encryptString,
  generateTotpSecret,
  generateTotpUri,
  verifyTotpCode,
  createMfaChallenge,
  verifyMfaChallenge,
} from '@evtivity/lib';
import QRCode from 'qrcode';
import { setAuthCookies, clearAuthCookies } from '../lib/csms-cookies.js';
import {
  createRefreshToken,
  validateAndRotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
  revokeAllUserSessions,
} from '../services/refresh-token.service.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  successResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
  errorWith,
  errorResponse,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize, invalidatePermissionCache } from '../middleware/rbac.js';
import { invalidateUserActiveCache } from '../plugins/auth.js';
import { invalidateSiteAccessCache } from '../lib/site-access.js';
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  ADMIN_DEFAULT_PERMISSIONS,
  OPERATOR_DEFAULT_PERMISSIONS,
  VIEWER_DEFAULT_PERMISSIONS,
} from '@evtivity/lib';
import { validatePasswordComplexity } from '../lib/password-validation.js';
import { config as apiConfig } from '../lib/config.js';
import {
  isMfaChallengeExhausted,
  recordMfaChallengeAttempt,
  clearMfaChallengeAttempts,
} from '../lib/rate-limiters.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = process.env['API_TEMPLATES_DIR'] ?? resolve(currentDir, '..', 'templates');
const OCPP_TEMPLATES_DIR =
  process.env['OCPP_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'ocpp', 'src', 'templates');
const ALL_TEMPLATES_DIRS = [OCPP_TEMPLATES_DIR, TEMPLATES_DIR];

// Lazily computed argon2 hash of random data, used to equalize timing on
// authentication endpoints when the lookup returns no user. Running
// argon2.verify against this on the no-user branch hides whether the email
// exists, mitigating email-enumeration timing attacks.
let dummyPasswordHashPromise: Promise<string> | null = null;
async function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHashPromise ??= argon2.hash(crypto.randomBytes(32).toString('hex'));
  return dummyPasswordHashPromise;
}

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  recaptchaToken: z
    .string()
    .optional()
    .describe('reCAPTCHA v3 token (required when reCAPTCHA is enabled)'),
});

const createUserBody = z.object({
  email: z
    .string()
    .email()
    .transform((s) => s.trim().toLowerCase()),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().max(50).optional().describe('Mobile phone number'),
  roleId: ID_PARAMS.roleId.describe('Role ID to assign to the user'),
  hasAllSiteAccess: z.boolean().default(false).describe('Whether the user can access all sites'),
  siteIds: z
    .array(z.string())
    .optional()
    .describe('Site IDs to grant access to (ignored when hasAllSiteAccess is true)'),
});

const userParams = z.object({
  id: ID_PARAMS.userId.describe('User ID'),
});

const updateUserBody = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().max(50).nullable().optional().describe('Mobile phone number'),
  roleId: ID_PARAMS.roleId.optional().describe('Role ID to assign to the user'),
  isActive: z.boolean().optional().describe('Whether the user account is active'),
  language: z.string().max(10).optional().describe('Preferred language code (e.g. en, es, zh)'),
  timezone: z.string().max(50).optional().describe('IANA timezone (e.g. America/New_York)'),
  themePreference: z.enum(['light', 'dark']).optional(),
  hasAllSiteAccess: z.boolean().optional().describe('Whether the user can access all sites'),
  siteIds: z
    .array(z.string())
    .optional()
    .describe('Site IDs to grant access to (replaces existing assignments)'),
});

const resetPasswordBody = z.object({
  password: z.string().min(12),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12),
});

const forgotPasswordBody = z.object({
  email: z.string().email(),
});

const resetPasswordWithTokenBody = z.object({
  token: z.string().min(1).describe('Password reset token from email link'),
  password: z.string().min(12),
});

const forceChangePasswordBody = z.object({
  email: z.string().email(),
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12),
});

const userSelect = {
  id: users.id,
  email: users.email,
  firstName: users.firstName,
  lastName: users.lastName,
  phone: users.phone,
  roleId: users.roleId,
  isActive: users.isActive,
  mustResetPassword: users.mustResetPassword,
  hasAllSiteAccess: users.hasAllSiteAccess,
  language: users.language,
  timezone: users.timezone,
  themePreference: users.themePreference,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

const loginResponse = z
  .object({
    token: z
      .string()
      .optional()
      .describe(
        'Operator JWT (kept for backward compatibility; cookies are the primary transport)',
      ),
    user: z
      .object({
        id: z.string().describe('User identifier'),
        email: z.string().describe('Email address'),
        firstName: z.string().nullable().describe('First name'),
        lastName: z.string().nullable().describe('Last name'),
        language: z.string().describe('Preferred UI language code'),
        timezone: z.string().optional().describe('IANA timezone identifier'),
      })
      .passthrough()
      .optional()
      .describe('Authenticated user, omitted when MFA is required'),
    role: z
      .object({
        id: z.string().describe('Role identifier'),
        name: z.string().describe('Role display name'),
      })
      .passthrough()
      .nullable()
      .optional()
      .describe('Role assigned to the user'),
    mfaRequired: z
      .boolean()
      .optional()
      .describe('Whether the user must complete MFA before authentication finishes'),
    mfaMethod: z.string().optional().describe('MFA method to use (email, sms, totp)'),
    mfaToken: z
      .string()
      .optional()
      .describe('Short-lived MFA pending token to send with the verify request'),
    challengeId: z
      .number()
      .optional()
      .describe('Identifier of the email/SMS challenge created for the user'),
    mustResetPassword: z
      .boolean()
      .optional()
      .describe('Whether the user must reset their password before continuing'),
  })
  .passthrough();

const userItem = z
  .object({
    id: z.string().describe('Identifier'),
    email: z.string().describe('Email address'),
    firstName: z.string().nullable().describe('First name'),
    lastName: z.string().nullable().describe('Last name'),
    phone: z.string().nullable().describe('Phone number for SMS notifications'),
    roleId: z.string().describe('Identifier of the assigned role'),
    isActive: z.boolean().describe('Whether the user can log in'),
    mustResetPassword: z
      .boolean()
      .describe('Whether the user must reset their password on next login'),
    language: z.string().describe('Preferred UI language code'),
    timezone: z.string().describe('IANA timezone identifier'),
    themePreference: z.string().describe('Preferred dashboard theme (light, dark, system)'),
    lastLoginAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp of the most recent successful login'),
    createdAt: z.coerce.date().describe('Timestamp when the user was created'),
  })
  .passthrough();

const userWithRole = z
  .object({
    id: z.string().describe('Identifier'),
    email: z.string().describe('Email address'),
    firstName: z.string().nullable().describe('First name'),
    lastName: z.string().nullable().describe('Last name'),
    roleId: z.string().describe('Identifier of the assigned role'),
    isActive: z.boolean().describe('Whether the user can log in'),
    mustResetPassword: z
      .boolean()
      .describe('Whether the user must reset their password on next login'),
    language: z.string().describe('Preferred UI language code'),
    timezone: z.string().describe('IANA timezone identifier'),
    lastLoginAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp of the most recent successful login'),
    createdAt: z.coerce.date().describe('Timestamp when the user was created'),
    role: z
      .object({
        id: z.string().describe('Role identifier'),
        name: z.string().describe('Role display name'),
      })
      .passthrough()
      .nullable()
      .describe('Joined role record'),
  })
  .passthrough();

const userCreated = z
  .object({
    id: z.string().describe('Identifier of the newly created user'),
    email: z.string().describe('Email address'),
    firstName: z.string().nullable().describe('First name'),
    lastName: z.string().nullable().describe('Last name'),
    roleId: z.string().describe('Identifier of the assigned role'),
  })
  .passthrough();

const roleItem = z
  .object({
    id: z.string().describe('Identifier'),
    name: z.string().describe('Role name (e.g., admin, operator)'),
  })
  .passthrough();

export function userRoutes(app: FastifyInstance): void {
  function isSecureRequest(request: FastifyRequest): boolean {
    const proto = request.headers['x-forwarded-proto'];
    if (typeof proto === 'string') {
      return proto.split(',')[0]?.trim() === 'https';
    }
    return request.protocol === 'https';
  }

  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['Users'],
        summary: 'Authenticate a user and return a JWT',
        operationId: 'loginUser',
        security: [],
        body: zodSchema(loginBody),
        response: {
          200: zodSchema(loginResponse),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          401: errorWith('Invalid credentials', [ERROR_CODES.INVALID_CREDENTIALS]),
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
      const { email, password, recaptchaToken } = request.body as z.infer<typeof loginBody>;

      // reCAPTCHA check
      const recaptchaConfig = await getRecaptchaConfig();
      if (recaptchaConfig != null) {
        if (recaptchaToken == null || recaptchaToken === '') {
          await reply
            .status(400)
            .send({ error: 'reCAPTCHA token is required', code: 'RECAPTCHA_REQUIRED' });
          return;
        }
        const encryptionKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
        const secretKey = decryptString(recaptchaConfig.secretKeyEnc, encryptionKey);
        const result = await verifyRecaptcha(recaptchaToken, secretKey, recaptchaConfig.threshold);
        if (!result.success) {
          await reply
            .status(403)
            .send({ error: 'reCAPTCHA verification failed', code: 'RECAPTCHA_FAILED' });
          return;
        }
      }

      const [user] = await db.select().from(users).where(ilike(users.email, email));

      if (user == null) {
        // Equalize timing with the user-exists branch so email enumeration
        // via response-time analysis fails.
        await argon2.verify(await getDummyPasswordHash(), password).catch(() => false);
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }

      const valid = await argon2.verify(user.passwordHash, password);
      if (!valid) {
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }

      if (!user.isActive) {
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      if (user.mustResetPassword) {
        await reply.status(200).send({ mustResetPassword: true });
        return;
      }

      // MFA check
      if (user.mfaEnabled && user.mfaMethod != null) {
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
            { email: user.email, firstName: user.firstName ?? undefined, language: user.language },
            { code: challenge.code },
            TEMPLATES_DIR,
          );
        }

        return {
          mfaRequired: true,
          mfaMethod: user.mfaMethod,
          mfaToken,
          challengeId,
        };
      }

      const [role] = await db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(eq(roles.id, user.roleId));

      const token = app.jwt.sign({ userId: user.id, roleId: user.roleId }, { expiresIn: '1h' });
      const refreshResult = await createRefreshToken({ userId: user.id });
      setAuthCookies(reply, token, refreshResult.rawToken, isSecureRequest(request));

      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

      return {
        token,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          language: user.language,
          timezone: user.timezone,
          themePreference: user.themePreference,
        },
        role: role ? { id: role.id, name: role.name } : null,
      };
    },
  );

  app.post(
    '/auth/logout',
    {
      onRequest: [authorize('users:write')],
      schema: {
        tags: ['Users'],
        summary: 'Logout and clear auth cookies',
        operationId: 'logout',
        security: [{ bearerAuth: [] }],
        response: { 200: successResponse },
      },
    },
    async (request, reply) => {
      const rawRefreshToken = request.cookies['csms_refresh'];
      if (rawRefreshToken) {
        await revokeRefreshToken(rawRefreshToken);
      }
      // Clear cached permissions for the logged-out user
      const jwtUser = request.user as unknown as Record<string, unknown>;
      if ('userId' in jwtUser && typeof jwtUser['userId'] === 'string') {
        invalidatePermissionCache(jwtUser['userId']);
      }
      clearAuthCookies(reply, isSecureRequest(request));
      return { success: true };
    },
  );

  app.post(
    '/auth/refresh',
    {
      schema: {
        tags: ['Users'],
        summary: 'Refresh access token using refresh token cookie',
        operationId: 'refreshToken',
        security: [],
        response: {
          200: successResponse,
          401: errorWith('Unauthorized', [
            ERROR_CODES.ACCOUNT_DISABLED,
            ERROR_CODES.NO_REFRESH_TOKEN,
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
      const rawToken = request.cookies['csms_refresh'];
      if (!rawToken) {
        await reply.status(401).send({ error: 'No refresh token', code: 'NO_REFRESH_TOKEN' });
        return;
      }

      const result = await validateAndRotateRefreshToken(rawToken);
      if (result == null || result.userId == null) {
        clearAuthCookies(reply, isSecureRequest(request));
        await reply
          .status(401)
          .send({ error: 'Invalid refresh token', code: 'INVALID_REFRESH_TOKEN' });
        return;
      }

      const [user] = await db
        .select({
          id: users.id,
          roleId: users.roleId,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.id, result.userId));

      if (!user || !user.isActive) {
        clearAuthCookies(reply, isSecureRequest(request));
        await reply.status(401).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      const accessToken = app.jwt.sign(
        { userId: user.id, roleId: user.roleId },
        { expiresIn: '1h' },
      );
      const newRefresh = await createRefreshToken({ userId: user.id });
      setAuthCookies(reply, accessToken, newRefresh.rawToken, isSecureRequest(request));

      return { success: true };
    },
  );

  app.post(
    '/auth/forgot-password',
    {
      schema: {
        tags: ['Users'],
        summary: 'Request a password reset email',
        operationId: 'forgotPassword',
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

      const [user] = await db
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          language: users.language,
        })
        .from(users)
        .where(ilike(users.email, email));

      if (user != null) {
        // Revoke existing password_reset tokens
        await db
          .update(userTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(userTokens.userId, user.id),
              eq(userTokens.type, 'password_reset'),
              isNull(userTokens.revokedAt),
            ),
          );

        // Generate token
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

        await db.insert(userTokens).values({
          userId: user.id,
          tokenHash,
          type: 'password_reset',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });

        // Send email
        const csmsUrl = apiConfig.CSMS_URL;
        const resetUrl = `${csmsUrl}/reset-password?token=${rawToken}`;

        try {
          const settings = await getNotificationSettings(client);
          if (settings.smtp != null) {
            const companyRows = await client`
              SELECT key, value FROM settings WHERE key LIKE 'company.%'
            `;
            const companyMap = new Map<string, string>();
            for (const row of companyRows) {
              if (typeof row.value === 'string') companyMap.set(row.key as string, row.value);
            }
            const companyName = companyMap.get('company.name') ?? 'EVtivity CSMS';
            const language = user.language;

            const enrichedVars: Record<string, unknown> = {
              companyName,
              companyContactEmail: companyMap.get('company.contactEmail') ?? '',
              companySupportPhone: companyMap.get('company.supportPhone') ?? '',
              companyStreet: companyMap.get('company.street') ?? '',
              companyCity: companyMap.get('company.city') ?? '',
              companyState: companyMap.get('company.state') ?? '',
              companyZip: companyMap.get('company.zip') ?? '',
              companyCountry: companyMap.get('company.country') ?? '',
              firstName: user.firstName ?? '',
              lastName: user.lastName ?? '',
              email,
              resetUrl,
            };

            const rendered = await renderTemplate(
              'email',
              'operator.ForgotPassword',
              language,
              enrichedVars,
              client,
              undefined,
              TEMPLATES_DIR,
            );
            const wrappedHtml =
              rendered.html != null
                ? wrapEmailHtml(
                    rendered.html,
                    companyName,
                    settings.emailWrapperTemplate,
                    enrichedVars,
                  )
                : undefined;
            const ok = await sendEmail(
              settings.smtp,
              email,
              rendered.subject,
              rendered.body,
              wrappedHtml,
            );
            const storedBody = wrappedHtml ?? rendered.body;
            await client`
              INSERT INTO notifications (channel, recipient, subject, body, status, event_type, sent_at)
              VALUES ('email', ${email}, ${rendered.subject}, ${storedBody}, ${ok ? 'sent' : 'failed'}, 'operator.ForgotPassword', NOW())
            `;
          }
        } catch {
          // Silently fail email sending to not leak user existence
        }
      }

      return { success: true };
    },
  );

  app.post(
    '/auth/reset-password',
    {
      schema: {
        tags: ['Users'],
        summary: 'Reset password using a token from the reset email',
        operationId: 'resetPassword',
        security: [],
        body: zodSchema(resetPasswordWithTokenBody),
        response: {
          200: successResponse,
          400: errorWith('Weak password', [ERROR_CODES.WEAK_PASSWORD]),
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { token, password } = request.body as z.infer<typeof resetPasswordWithTokenBody>;

      const complexityError = validatePasswordComplexity(password);
      if (complexityError != null) {
        await reply.status(400).send({ error: complexityError, code: 'WEAK_PASSWORD' });
        return;
      }

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const [tokenRow] = await db
        .select({
          id: userTokens.id,
          userId: userTokens.userId,
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

      if (tokenRow == null || tokenRow.userId == null || tokenRow.expiresAt < new Date()) {
        await reply
          .status(400)
          .send({ error: 'Invalid or expired reset link', code: 'INVALID_TOKEN' });
        return;
      }

      const passwordHash = await argon2.hash(password);

      await db
        .update(users)
        .set({ passwordHash, mustResetPassword: false, updatedAt: new Date() })
        .where(eq(users.id, tokenRow.userId));

      await db
        .update(userTokens)
        .set({ revokedAt: new Date() })
        .where(eq(userTokens.id, tokenRow.id));

      const [updatedUser] = await db
        .select({
          id: users.id,
          email: users.email,
          phone: users.phone,
          firstName: users.firstName,
          lastName: users.lastName,
          language: users.language,
        })
        .from(users)
        .where(eq(users.id, tokenRow.userId));

      if (updatedUser != null) {
        void dispatchSystemNotification(
          client,
          'operator.PasswordChanged',
          {
            email: updatedUser.email,
            phone: updatedUser.phone ?? undefined,
            userId: updatedUser.id,
            language: updatedUser.language,
          },
          {
            firstName: updatedUser.firstName ?? '',
            lastName: updatedUser.lastName ?? '',
            email: updatedUser.email,
          },
          ALL_TEMPLATES_DIRS,
        );
      }

      return { success: true };
    },
  );

  app.post(
    '/auth/force-change-password',
    {
      schema: {
        tags: ['Users'],
        summary: 'Change password for a user that has mustResetPassword set',
        operationId: 'forceChangePassword',
        security: [],
        body: zodSchema(forceChangePasswordBody),
        response: {
          200: zodSchema(loginResponse),
          400: errorWith('Weak password', [ERROR_CODES.WEAK_PASSWORD]),
          401: errorWith('Invalid credentials', [ERROR_CODES.INVALID_CREDENTIALS]),
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
      const { email, currentPassword, newPassword } = request.body as z.infer<
        typeof forceChangePasswordBody
      >;

      const [user] = await db.select().from(users).where(ilike(users.email, email));

      if (user == null) {
        // Equalize timing with the user-exists branch (see login handler).
        await argon2.verify(await getDummyPasswordHash(), currentPassword).catch(() => false);
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }

      if (!user.mustResetPassword) {
        await reply
          .status(400)
          .send({ error: 'Password reset is not required', code: 'RESET_NOT_REQUIRED' });
        return;
      }

      if (!user.isActive) {
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      const valid = await argon2.verify(user.passwordHash, currentPassword);
      if (!valid) {
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }

      const complexityError = validatePasswordComplexity(newPassword);
      if (complexityError != null) {
        await reply.status(400).send({ error: complexityError, code: 'WEAK_PASSWORD' });
        return;
      }

      const passwordHash = await argon2.hash(newPassword);

      await db
        .update(users)
        .set({ passwordHash, mustResetPassword: false, updatedAt: new Date() })
        .where(eq(users.id, user.id));

      // Revoke any existing sessions before issuing the new one. Mirrors
      // /users/me/change-password and the admin reset-password handler so
      // forced-reset password changes terminate other devices' sessions.
      await revokeAllUserSessions(user.id);

      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: user.id,
          entityIdSnapshot: user.id,
          action: 'password_reset',
          ...getAuditActor(request),
          notes: 'User changed own password (forced reset)',
        },
        db,
        request.log,
      );

      const [role] = await db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(eq(roles.id, user.roleId));

      const token = app.jwt.sign({ userId: user.id, roleId: user.roleId }, { expiresIn: '1h' });
      const refreshResult = await createRefreshToken({ userId: user.id });
      setAuthCookies(reply, token, refreshResult.rawToken, isSecureRequest(request));

      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

      return {
        token,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          language: user.language,
          timezone: user.timezone,
          themePreference: user.themePreference,
        },
        role: role ? { id: role.id, name: role.name } : null,
      };
    },
  );

  app.get(
    '/users/me',
    {
      onRequest: [authorize('users:read')],
      schema: {
        tags: ['Users'],
        summary: 'Get the currently authenticated user',
        operationId: 'getCurrentUser',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(userWithRole),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string; roleId: string };

      const [user] = await db.select(userSelect).from(users).where(eq(users.id, userId));

      if (user == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      const [role, permRows] = await Promise.all([
        db.select({ id: roles.id, name: roles.name }).from(roles).where(eq(roles.id, user.roleId)),
        db
          .select({ permission: userPermissions.permission })
          .from(userPermissions)
          .where(eq(userPermissions.userId, userId)),
      ]);

      return {
        ...user,
        role: role[0] ? { id: role[0].id, name: role[0].name } : null,
        permissions: permRows.map((r) => r.permission),
      };
    },
  );

  app.get(
    '/users',
    {
      onRequest: [authorize('users:read')],
      schema: {
        tags: ['Users'],
        summary: 'List all users with pagination',
        operationId: 'listUsers',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(
          paginationQuery.extend({
            roleId: ID_PARAMS.roleId.optional().describe('Filter by role ID'),
            status: z.enum(['active', 'inactive']).optional().describe('Filter by user status'),
          }),
        ),
        response: { 200: paginatedResponse(userItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof paginationQuery> & {
        roleId?: string;
        status?: 'active' | 'inactive';
      };
      const { page, limit, search, roleId, status } = query;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (search) {
        const pattern = `%${search}%`;
        conditions.push(
          or(
            ilike(users.id, pattern),
            ilike(users.email, pattern),
            ilike(users.firstName, pattern),
            ilike(users.lastName, pattern),
          ),
        );
      }
      if (roleId != null) {
        conditions.push(eq(users.roleId, roleId));
      }
      if (status != null) {
        conditions.push(eq(users.isActive, status === 'active'));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db.select(userSelect).from(users).where(where).limit(limit).offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(users)
          .where(where),
      ]);

      // Enrich users with site assignment counts
      const userIds = data.map((u) => u.id);
      let siteCounts: { userId: string; count: number }[] = [];
      if (userIds.length > 0) {
        siteCounts = await db
          .select({
            userId: userSiteAssignments.userId,
            count: sql<number>`count(*)::int`,
          })
          .from(userSiteAssignments)
          .where(inArray(userSiteAssignments.userId, userIds))
          .groupBy(userSiteAssignments.userId);
      }
      const siteCountMap = new Map(siteCounts.map((r) => [r.userId, r.count]));

      const enriched = data.map((u) => ({
        ...u,
        siteCount: u.hasAllSiteAccess ? null : (siteCountMap.get(u.id) ?? 0),
      }));

      return { data: enriched, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof enriched)[number]
      >;
    },
  );

  app.post(
    '/users',
    {
      onRequest: [authorize('users:write')],
      schema: {
        tags: ['Users'],
        summary: 'Create a new user',
        description:
          'Creates a user with mustResetPassword=true, copies the role default permissions into user_permissions, applies site access (hasAllSiteAccess or per-site assignments via user_site_assignments), and sends an invitation email containing a setup link. Returns 409 on duplicate email.',
        operationId: 'createUser',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createUserBody),
        response: {
          201: itemResponse(userCreated),
          400: errorResponse,
          409: errorWith('Email already in use', [ERROR_CODES.DUPLICATE_EMAIL]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createUserBody>;

      // Pre-check the unique email constraint (case-insensitive) so we return
      // a clean 409 instead of letting Postgres raise a 500. Body email is
      // already lowercased + trimmed by the Zod transform on createUserBody.
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(ilike(users.email, body.email))
        .limit(1);
      if (existing != null) {
        await reply.status(409).send({ error: 'Email already in use', code: 'DUPLICATE_EMAIL' });
        return;
      }

      // Pre-validate roleId so a bad FK returns a clean 400 instead of a
      // Postgres FK violation surfaced as 500.
      const [role] = await db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.id, body.roleId))
        .limit(1);
      if (role == null) {
        await reply.status(400).send({ error: 'Role does not exist', code: 'ROLE_NOT_FOUND' });
        return;
      }

      // Pre-validate site assignments so a bad siteId returns a clean 400
      // instead of a Postgres FK violation surfaced as 500. Dedupe the
      // input first so duplicates don't trip the (userId, siteId) UNIQUE
      // constraint on insert.
      const createSiteIds =
        body.hasAllSiteAccess || body.siteIds == null ? [] : [...new Set(body.siteIds)];
      if (createSiteIds.length > 0) {
        const found = await db
          .select({ id: sites.id })
          .from(sites)
          .where(inArray(sites.id, createSiteIds));
        if (found.length !== createSiteIds.length) {
          await reply
            .status(400)
            .send({ error: 'One or more siteIds do not exist', code: 'INVALID_SITE_IDS' });
          return;
        }
      }

      // Generate unknown random password — user must set via email link
      const passwordHash = await argon2.hash(crypto.randomBytes(32).toString('hex'));

      const rows = await db
        .insert(users)
        .values({
          email: body.email,
          passwordHash,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          roleId: body.roleId,
          mustResetPassword: true,
        })
        .returning({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          phone: users.phone,
          roleId: users.roleId,
        });

      // INSERT RETURNING always yields a row; this guard satisfies noUncheckedIndexedAccess
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const user = rows[0]!;

      // Site access: set hasAllSiteAccess or insert site assignments
      if (body.hasAllSiteAccess) {
        await db.update(users).set({ hasAllSiteAccess: true }).where(eq(users.id, user.id));
      } else if (createSiteIds.length > 0) {
        await db.insert(userSiteAssignments).values(
          createSiteIds.map((siteId) => ({
            userId: user.id,
            siteId,
          })),
        );
      }

      // Populate user permissions from role defaults
      const [createdRole] = await db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, body.roleId));

      const roleDefaults =
        createdRole?.name === 'admin'
          ? ADMIN_DEFAULT_PERMISSIONS
          : createdRole?.name === 'viewer'
            ? VIEWER_DEFAULT_PERMISSIONS
            : OPERATOR_DEFAULT_PERMISSIONS;

      if (roleDefaults.length > 0) {
        await db
          .insert(userPermissions)
          .values(roleDefaults.map((p) => ({ userId: user.id, permission: p })))
          .onConflictDoNothing();
      }

      // Generate 24-hour password setup token
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      await db.insert(userTokens).values({
        userId: user.id,
        tokenHash,
        type: 'password_reset',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const csmsUrl = apiConfig.CSMS_URL;
      const setPasswordUrl = `${csmsUrl}/reset-password?token=${rawToken}`;

      void dispatchSystemNotification(
        client,
        'operator.UserCreated',
        { email: user.email, phone: user.phone ?? undefined, userId: user.id, language: 'en' },
        {
          firstName: user.firstName ?? '',
          lastName: user.lastName ?? '',
          email: user.email,
          setPasswordUrl,
        },
        ALL_TEMPLATES_DIRS,
      );

      const actor = getAuditActor(request);
      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: user.id,
          entityIdSnapshot: user.id,
          action: 'created',
          ...actor,
          after: {
            ...user,
            hasAllSiteAccess: body.hasAllSiteAccess,
            siteIds: body.hasAllSiteAccess ? [] : (body.siteIds ?? []),
          },
        },
        db,
        request.log,
      );

      await reply.status(201).send({
        ...user,
        hasAllSiteAccess: body.hasAllSiteAccess,
        siteIds: body.hasAllSiteAccess ? [] : (body.siteIds ?? []),
      });
    },
  );

  app.get(
    '/users/:id',
    {
      onRequest: [authorize('users:read')],
      schema: {
        tags: ['Users'],
        summary: 'Get a user by ID',
        operationId: 'getUser',
        security: [{ bearerAuth: [] }],
        params: zodSchema(userParams),
        response: {
          200: itemResponse(userItem),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof userParams>;

      const [user] = await db.select(userSelect).from(users).where(eq(users.id, id));

      if (user == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      const [assignments, permRows] = await Promise.all([
        db
          .select({ siteId: userSiteAssignments.siteId })
          .from(userSiteAssignments)
          .where(eq(userSiteAssignments.userId, id)),
        db
          .select({ permission: userPermissions.permission })
          .from(userPermissions)
          .where(eq(userPermissions.userId, id)),
      ]);

      return {
        ...user,
        siteIds: assignments.map((a) => a.siteId),
        permissions: permRows.map((r) => r.permission),
      };
    },
  );

  app.patch(
    '/users/:id',
    {
      onRequest: [authorize('users:write')],
      schema: {
        tags: ['Users'],
        summary: 'Update a user by ID',
        operationId: 'updateUser',
        security: [{ bearerAuth: [] }],
        params: zodSchema(userParams),
        body: zodSchema(updateUserBody),
        response: {
          200: itemResponse(userItem),
          400: errorResponse,
          403: errorWith('Self edit forbidden', [ERROR_CODES.SELF_EDIT_FORBIDDEN]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof userParams>;
      const body = request.body as z.infer<typeof updateUserBody>;

      // Block self-edit of sensitive fields (role, status, site access)
      // Users can edit their own name, language, timezone, theme via Profile
      if (id === userId) {
        if (
          body.roleId !== undefined ||
          body.isActive !== undefined ||
          body.hasAllSiteAccess !== undefined ||
          body.siteIds !== undefined
        ) {
          await reply.status(403).send({
            error: 'Cannot edit your own role, status, or site access',
            code: 'SELF_EDIT_FORBIDDEN',
          });
          return;
        }
      }

      // Pre-validate roleId FK so a bad role returns a clean 400 instead
      // of a Postgres FK violation surfaced as 500.
      if (body.roleId !== undefined) {
        const [role] = await db
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.id, body.roleId))
          .limit(1);
        if (role == null) {
          await reply.status(400).send({ error: 'Role does not exist', code: 'ROLE_NOT_FOUND' });
          return;
        }
      }

      const fields: Record<string, unknown> = { updatedAt: new Date() };
      if (body.firstName !== undefined) fields['firstName'] = body.firstName;
      if (body.lastName !== undefined) fields['lastName'] = body.lastName;
      if (body.phone !== undefined) fields['phone'] = body.phone;
      if (body.roleId !== undefined) fields['roleId'] = body.roleId;
      if (body.isActive !== undefined) fields['isActive'] = body.isActive;
      if (body.language !== undefined) fields['language'] = body.language;
      if (body.timezone !== undefined) fields['timezone'] = body.timezone;
      if (body.themePreference !== undefined) fields['themePreference'] = body.themePreference;
      if (body.hasAllSiteAccess !== undefined) fields['hasAllSiteAccess'] = body.hasAllSiteAccess;

      const [before] = await db.select(userSelect).from(users).where(eq(users.id, id));
      const [updated] = await db
        .update(users)
        .set(fields)
        .where(eq(users.id, id))
        .returning(userSelect);

      if (updated == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      // Update site assignments if provided. Pre-validate so a bad siteId
      // returns a clean 400 instead of a Postgres FK violation surfaced
      // as 500. Dedupe the input so duplicates don't trip the
      // (userId, siteId) UNIQUE constraint on insert.
      if (body.siteIds !== undefined) {
        const patchSiteIds = [...new Set(body.siteIds)];
        if (patchSiteIds.length > 0) {
          const found = await db
            .select({ id: sites.id })
            .from(sites)
            .where(inArray(sites.id, patchSiteIds));
          if (found.length !== patchSiteIds.length) {
            await reply
              .status(400)
              .send({ error: 'One or more siteIds do not exist', code: 'INVALID_SITE_IDS' });
            return;
          }
        }
        await db.delete(userSiteAssignments).where(eq(userSiteAssignments.userId, id));

        if (patchSiteIds.length > 0) {
          await db.insert(userSiteAssignments).values(
            patchSiteIds.map((siteId) => ({
              userId: id,
              siteId,
            })),
          );
        }
      }

      // Invalidate site access cache when site access fields change
      if (body.hasAllSiteAccess !== undefined || body.siteIds !== undefined) {
        invalidateSiteAccessCache(id);
      }

      // Deactivation: revoke all sessions and clear the isActive cache so
      // the user is locked out immediately rather than after the 30s cache
      // window plus the JWT lifetime.
      if (body.isActive === false) {
        await revokeAllUserRefreshTokens(id);
        invalidateUserActiveCache(id);
      }

      // Reset permissions to new role defaults when roleId changes
      if (body.roleId !== undefined) {
        const [newRole] = await db
          .select({ name: roles.name })
          .from(roles)
          .where(eq(roles.id, body.roleId));

        const defaults =
          newRole?.name === 'admin'
            ? ADMIN_DEFAULT_PERMISSIONS
            : newRole?.name === 'viewer'
              ? VIEWER_DEFAULT_PERMISSIONS
              : OPERATOR_DEFAULT_PERMISSIONS;

        await db.delete(userPermissions).where(eq(userPermissions.userId, id));
        if (defaults.length > 0) {
          await db
            .insert(userPermissions)
            .values(defaults.map((p) => ({ userId: id, permission: p })))
            .onConflictDoNothing();
        }
        invalidatePermissionCache(id);
        await revokeAllUserSessions(id);
      }

      // Re-fetch site assignments and permissions for the response
      const [assignments, permRows] = await Promise.all([
        db
          .select({ siteId: userSiteAssignments.siteId })
          .from(userSiteAssignments)
          .where(eq(userSiteAssignments.userId, id)),
        db
          .select({ permission: userPermissions.permission })
          .from(userPermissions)
          .where(eq(userPermissions.userId, id)),
      ]);

      const actor = getAuditActor(request);
      let action: string = 'updated';
      if (body.roleId !== undefined && before != null && body.roleId !== before.roleId) {
        action = 'role_changed';
      } else if (body.hasAllSiteAccess !== undefined || body.siteIds !== undefined) {
        action = 'site_access_changed';
      }
      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: updated.id,
          entityIdSnapshot: updated.id,
          action,
          ...actor,
          before: before ?? null,
          after: { ...updated, siteIds: assignments.map((a) => a.siteId) },
        },
        db,
        request.log,
      );

      return {
        ...updated,
        siteIds: assignments.map((a) => a.siteId),
        permissions: permRows.map((r) => r.permission),
      };
    },
  );

  app.post(
    '/users/:id/reset-password',
    {
      onRequest: [authorize('users:write')],
      schema: {
        tags: ['Users'],
        summary: 'Reset a user password by admin',
        description:
          'Generates a new temporary password for the target user, hashes it with argon2, and sets mustResetPassword=true so the user is forced to change it on next login. Revokes all of the user existing refresh tokens. The new password is returned in the response and must be communicated out-of-band.',
        operationId: 'resetUserPassword',
        security: [{ bearerAuth: [] }],
        params: zodSchema(userParams),
        body: zodSchema(resetPasswordBody),
        response: {
          200: successResponse,
          400: errorWith('Weak password', [ERROR_CODES.WEAK_PASSWORD]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof userParams>;
      const { password } = request.body as z.infer<typeof resetPasswordBody>;

      const complexityError = validatePasswordComplexity(password);
      if (complexityError != null) {
        await reply.status(400).send({ error: complexityError, code: 'WEAK_PASSWORD' });
        return;
      }

      const passwordHash = await argon2.hash(password);

      const [updated] = await db
        .update(users)
        .set({ passwordHash, mustResetPassword: true, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning({ id: users.id });

      if (updated == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      await revokeAllUserSessions(updated.id);

      const actor = getAuditActor(request);
      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: updated.id,
          entityIdSnapshot: updated.id,
          action: 'password_reset',
          ...actor,
          notes: 'Password reset by admin',
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );

  app.post(
    '/users/me/change-password',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Change the current user password',
        operationId: 'changePassword',
        security: [{ bearerAuth: [] }],
        body: zodSchema(changePasswordBody),
        response: {
          200: successResponse,
          400: errorWith('Weak password', [ERROR_CODES.WEAK_PASSWORD]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string; roleId: string };
      const { currentPassword, newPassword } = request.body as z.infer<typeof changePasswordBody>;

      const [user] = await db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId));

      if (user == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      const valid = await argon2.verify(user.passwordHash, currentPassword);
      if (!valid) {
        await reply
          .status(400)
          .send({ error: 'Current password is incorrect', code: 'INVALID_PASSWORD' });
        return;
      }

      const complexityError = validatePasswordComplexity(newPassword);
      if (complexityError != null) {
        await reply.status(400).send({ error: complexityError, code: 'WEAK_PASSWORD' });
        return;
      }

      const passwordHash = await argon2.hash(newPassword);
      await db
        .update(users)
        .set({ passwordHash, mustResetPassword: false, updatedAt: new Date() })
        .where(eq(users.id, userId));

      await revokeAllUserSessions(userId);

      const actor = getAuditActor(request);
      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: userId,
          entityIdSnapshot: userId,
          action: 'password_reset',
          ...actor,
          notes: 'User changed own password',
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );

  app.delete(
    '/users/:id',
    {
      onRequest: [authorize('users:write')],
      schema: {
        tags: ['Users'],
        summary: 'Deactivate a user by ID',
        operationId: 'deleteUser',
        security: [{ bearerAuth: [] }],
        params: zodSchema(userParams),
        response: {
          204: { type: 'null' as const },
          403: errorWith('Self edit forbidden', [ERROR_CODES.SELF_EDIT_FORBIDDEN]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof userParams>;
      const { userId: actorUserId } = request.user as JwtPayload;

      // Mirror the PATCH self-edit block: an admin shouldn't be able to
      // deactivate themselves and lock the system out (or at minimum lock
      // their own account).
      if (id === actorUserId) {
        await reply
          .status(403)
          .send({ error: 'Cannot deactivate your own account', code: 'SELF_EDIT_FORBIDDEN' });
        return;
      }

      const [user] = await db.select().from(users).where(eq(users.id, id));
      if (user == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      await db
        .update(users)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(users.id, id));

      invalidateUserActiveCache(id);
      invalidatePermissionCache(id);
      invalidateSiteAccessCache(id);
      await revokeAllUserRefreshTokens(id);

      const actor = getAuditActor(request);
      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: user.id,
          entityIdSnapshot: user.id,
          action: 'deleted',
          ...actor,
          before: user,
        },
        db,
        request.log,
      );

      await reply.status(204).send();
    },
  );

  app.post(
    '/users/:id/resend-invite',
    {
      onRequest: [authorize('users:write')],
      schema: {
        tags: ['Users'],
        summary: 'Resend account setup invitation to a user',
        description:
          'Generates a fresh password reset token for the user and sends a new invitation email with the setup link. Used to recover from expired or lost invitations. Only valid for users that have never logged in or have mustResetPassword set.',
        operationId: 'resendUserInvite',
        security: [{ bearerAuth: [] }],
        params: zodSchema(userParams),
        response: {
          200: successResponse,
          403: errorWith('Account disabled', [ERROR_CODES.ACCOUNT_DISABLED]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof userParams>;

      const [user] = await db
        .select({
          id: users.id,
          email: users.email,
          phone: users.phone,
          firstName: users.firstName,
          lastName: users.lastName,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.id, id));

      if (user == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }
      if (!user.isActive) {
        // No point sending a setup email to an account that can't log in.
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      // Revoke existing password_reset tokens
      await db
        .update(userTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(userTokens.userId, user.id),
            eq(userTokens.type, 'password_reset'),
            isNull(userTokens.revokedAt),
          ),
        );

      // Generate new 24-hour token
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      await db.insert(userTokens).values({
        userId: user.id,
        tokenHash,
        type: 'password_reset',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const csmsUrl = apiConfig.CSMS_URL;
      const setPasswordUrl = `${csmsUrl}/reset-password?token=${rawToken}`;

      void dispatchSystemNotification(
        client,
        'operator.UserCreated',
        { email: user.email, phone: user.phone ?? undefined, userId: user.id, language: 'en' },
        {
          firstName: user.firstName ?? '',
          lastName: user.lastName ?? '',
          email: user.email,
          setPasswordUrl,
        },
        ALL_TEMPLATES_DIRS,
      );

      return { success: true };
    },
  );

  app.get(
    '/roles',
    {
      onRequest: [authorize('users:read')],
      schema: {
        tags: ['Users'],
        summary: 'List all available roles',
        operationId: 'listRoles',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(roleItem) },
      },
    },
    async () => {
      return db.select().from(roles);
    },
  );

  // MFA verify endpoint
  const mfaVerifyBody = z.object({
    mfaToken: z.string().min(1).describe('Short-lived MFA pending JWT'),
    code: z.string().min(6).max(6).describe('6-digit verification code'),
    challengeId: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Challenge ID for email/SMS codes'),
  });

  app.post(
    '/auth/mfa/verify',
    {
      schema: {
        tags: ['Users'],
        summary: 'Verify MFA code and complete login',
        description:
          'Validates the short-lived MFA pending JWT, verifies the supplied TOTP code or email/SMS challenge code (single-use, 5-minute TTL), and on success issues the real access JWT plus refresh token cookies. Returns 401 if the code is invalid, expired, or already used.',
        operationId: 'verifyMfa',
        security: [],
        body: zodSchema(mfaVerifyBody),
        response: {
          200: zodSchema(loginResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
            ERROR_CODES.MFA_NOT_CONFIGURED,
            ERROR_CODES.MFA_TOKEN_INVALID,
            ERROR_CODES.TOTP_NOT_CONFIGURED,
          ]),
          401: errorWith('Unauthorized', [ERROR_CODES.UNAUTHORIZED]),
          403: errorWith('Account disabled', [ERROR_CODES.ACCOUNT_DISABLED]),
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { mfaToken, code, challengeId } = request.body as z.infer<typeof mfaVerifyBody>;

      let payload: { userId: string; roleId: string; mfaPending?: boolean };
      try {
        payload = app.jwt.verify(mfaToken);
      } catch {
        await reply
          .status(401)
          .send({ error: 'Invalid or expired MFA token', code: 'MFA_TOKEN_EXPIRED' });
        return;
      }

      if (!payload.mfaPending) {
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

      const [user] = await db.select().from(users).where(eq(users.id, payload.userId));
      if (user == null || !user.mfaEnabled || user.mfaMethod == null) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }
      if (!user.isActive) {
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      let verified = false;
      if (user.mfaMethod === 'totp') {
        if (user.totpSecretEnc == null) {
          await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
          return;
        }
        const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
        try {
          const secret = decryptString(user.totpSecretEnc, encKey);
          verified = verifyTotpCode(secret, code);
        } catch (err: unknown) {
          // Stored TOTP secret cannot be decrypted (e.g. SETTINGS_ENCRYPTION_KEY
          // rotated, ciphertext corrupted). Surface as a clean MFA failure
          // rather than a 500, but log the underlying error for ops.
          request.log.warn({ err, userId: payload.userId }, 'TOTP secret decrypt failed');
          verified = false;
        }
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

      const [role] = await db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(eq(roles.id, user.roleId));

      const token = app.jwt.sign({ userId: user.id, roleId: user.roleId }, { expiresIn: '1h' });
      const refreshResult = await createRefreshToken({ userId: user.id });
      setAuthCookies(reply, token, refreshResult.rawToken, isSecureRequest(request));
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

      return {
        token,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          language: user.language,
          timezone: user.timezone,
          themePreference: user.themePreference,
        },
        role: role ? { id: role.id, name: role.name } : null,
      };
    },
  );

  // MFA resend code
  const mfaResendBody = z.object({
    mfaToken: z.string().min(1),
  });

  app.post(
    '/auth/mfa/resend',
    {
      schema: {
        tags: ['Users'],
        summary: 'Resend MFA verification code',
        description:
          'Creates a new mfa_challenges row and dispatches a fresh 6-digit code via the email or SMS channel selected at login. Only applies to email/SMS methods (TOTP needs no resend). Returns 400 if the MFA pending JWT has expired.',
        operationId: 'resendMfa',
        security: [],
        body: zodSchema(mfaResendBody),
        response: {
          200: itemResponse(
            z
              .object({
                challengeId: z
                  .number()
                  .int()
                  .min(1)
                  .describe('Identifier of the new MFA challenge that was created'),
              })
              .passthrough(),
          ),
          400: errorWith('Bad request', [
            ERROR_CODES.MFA_NOT_CONFIGURED,
            ERROR_CODES.MFA_TOKEN_INVALID,
          ]),
          401: errorWith('Unauthorized', [ERROR_CODES.UNAUTHORIZED]),
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { mfaToken } = request.body as z.infer<typeof mfaResendBody>;

      let payload: { userId: string; roleId: string; mfaPending?: boolean };
      try {
        payload = app.jwt.verify(mfaToken);
      } catch {
        await reply
          .status(401)
          .send({ error: 'Invalid or expired MFA token', code: 'MFA_TOKEN_EXPIRED' });
        return;
      }

      if (!payload.mfaPending) {
        await reply.status(400).send({ error: 'Invalid MFA token', code: 'MFA_TOKEN_INVALID' });
        return;
      }

      const [user] = await db.select().from(users).where(eq(users.id, payload.userId));
      if (user == null || !user.mfaEnabled || user.mfaMethod == null) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }

      if (user.mfaMethod === 'totp') {
        await reply
          .status(400)
          .send({ error: 'Cannot resend TOTP codes', code: 'MFA_TOTP_NO_RESEND' });
        return;
      }

      const challenge = await createMfaChallenge(client, {
        userId: user.id,
        method: user.mfaMethod,
      });

      await dispatchSystemNotification(
        client,
        'mfa.VerificationCode',
        { email: user.email, firstName: user.firstName ?? undefined, language: user.language },
        { code: challenge.code },
        TEMPLATES_DIR,
      );

      return { challengeId: challenge.challengeId };
    },
  );

  // MFA profile setup endpoints

  const mfaStatusResponse = z
    .object({
      mfaEnabled: z.boolean().describe('Whether MFA is enabled for the user'),
      mfaMethod: z.string().nullable().describe('Currently enrolled MFA method (email, sms, totp)'),
      availableMethods: z
        .array(z.string())
        .describe('MFA methods the system has enabled and the user may enroll in'),
    })
    .passthrough();

  app.get(
    '/users/me/mfa',
    {
      onRequest: [authorize('users:read')],
      schema: {
        tags: ['Users'],
        summary: 'Get current MFA status',
        operationId: 'getMfaStatus',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(mfaStatusResponse) },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string; roleId: string };
      const [user] = await db
        .select({ mfaEnabled: users.mfaEnabled, mfaMethod: users.mfaMethod })
        .from(users)
        .where(eq(users.id, userId));

      const mfaConfig = await getMfaConfig();
      const availableMethods: string[] = [];
      if (mfaConfig.emailEnabled) availableMethods.push('email');
      if (mfaConfig.totpEnabled) availableMethods.push('totp');
      if (mfaConfig.smsEnabled) availableMethods.push('sms');

      return {
        mfaEnabled: user?.mfaEnabled ?? false,
        mfaMethod: user?.mfaMethod ?? null,
        availableMethods,
      };
    },
  );

  const mfaSetupBody = z.object({
    method: z.enum(['email', 'totp', 'sms']).describe('MFA method to set up'),
  });

  const mfaSetupResponse = z
    .object({
      qrDataUri: z.string().optional().describe('Data URI of the TOTP QR code (TOTP setup only)'),
      secret: z
        .string()
        .optional()
        .describe('TOTP shared secret in case the user cannot scan the QR code'),
      challengeId: z
        .number()
        .optional()
        .describe('Identifier of the email/SMS verification challenge'),
    })
    .passthrough();

  app.post(
    '/users/me/mfa/setup',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Start MFA setup',
        description:
          'Begins MFA enrollment for the requested method. For TOTP, returns the new secret and otpauth URI plus a QR code data URL. For email/SMS, dispatches a verification code to the user contact and returns a challengeId. Setup is not active until confirmed via the confirm endpoint.',
        operationId: 'setupMfa',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaSetupBody),
        response: {
          200: itemResponse(mfaSetupResponse),
          400: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string; roleId: string };
      const { method } = request.body as z.infer<typeof mfaSetupBody>;

      const mfaConfig = await getMfaConfig();
      const methodEnabled =
        (method === 'email' && mfaConfig.emailEnabled) ||
        (method === 'totp' && mfaConfig.totpEnabled) ||
        (method === 'sms' && mfaConfig.smsEnabled);
      if (!methodEnabled) {
        await reply
          .status(403)
          .send({ error: 'MFA method is disabled', code: 'MFA_METHOD_DISABLED' });
        return;
      }

      const [user] = await db
        .select({ email: users.email, firstName: users.firstName, language: users.language })
        .from(users)
        .where(eq(users.id, userId));
      if (user == null) {
        await reply.status(400).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      if (method === 'totp') {
        const secret = generateTotpSecret();
        const uri = generateTotpUri(secret, user.email, 'EVtivity CSMS');
        const qrDataUri = await QRCode.toDataURL(uri);

        // Store secret temporarily encrypted
        const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
        const encSecret = encryptString(secret, encKey);
        await db
          .update(users)
          .set({ totpSecretEnc: encSecret, updatedAt: new Date() })
          .where(eq(users.id, userId));

        return { qrDataUri, secret };
      }

      // Email or SMS: send verification code
      const challenge = await createMfaChallenge(client, { userId, method });

      await dispatchSystemNotification(
        client,
        'mfa.VerificationCode',
        { email: user.email, firstName: user.firstName ?? undefined, language: user.language },
        { code: challenge.code },
        TEMPLATES_DIR,
      );

      return { challengeId: challenge.challengeId };
    },
  );

  const mfaConfirmBody = z.object({
    method: z.enum(['email', 'totp', 'sms']),
    code: z.string().min(6).max(6),
    challengeId: z.coerce.number().int().min(1).optional(),
  });

  app.post(
    '/users/me/mfa/confirm',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Confirm MFA setup with verification code',
        description:
          'Verifies the supplied code against the in-flight MFA setup (TOTP secret or email/SMS challenge). On success, persists the secret (encrypted for TOTP) and flips mfaEnabled=true on the user. Returns 400 if the code is invalid or the setup has expired.',
        operationId: 'confirmMfa',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaConfirmBody),
        response: {
          200: successResponse,
          400: errorWith('Totp not configured', [ERROR_CODES.TOTP_NOT_CONFIGURED]),
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string; roleId: string };
      const { method, code, challengeId } = request.body as z.infer<typeof mfaConfirmBody>;

      const mfaConfig = await getMfaConfig();
      const methodEnabled =
        (method === 'email' && mfaConfig.emailEnabled) ||
        (method === 'totp' && mfaConfig.totpEnabled) ||
        (method === 'sms' && mfaConfig.smsEnabled);
      if (!methodEnabled) {
        await reply
          .status(403)
          .send({ error: 'MFA method is disabled', code: 'MFA_METHOD_DISABLED' });
        return;
      }

      let verified = false;
      if (method === 'totp') {
        const [user] = await db
          .select({ totpSecretEnc: users.totpSecretEnc })
          .from(users)
          .where(eq(users.id, userId));
        if (user?.totpSecretEnc == null) {
          await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
          return;
        }
        const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
        try {
          const secret = decryptString(user.totpSecretEnc, encKey);
          verified = verifyTotpCode(secret, code);
        } catch (err: unknown) {
          // Stored TOTP secret cannot be decrypted (e.g. SETTINGS_ENCRYPTION_KEY
          // rotated, ciphertext corrupted). Surface as a clean MFA failure
          // rather than a 500, but log the underlying error for ops.
          request.log.warn({ err, userId }, 'TOTP secret decrypt failed');
          verified = false;
        }
      } else if (challengeId != null) {
        verified = await verifyMfaChallenge(client, challengeId, code);
      }

      if (!verified) {
        await reply
          .status(400)
          .send({ error: 'Invalid verification code', code: 'MFA_CODE_INVALID' });
        return;
      }

      await db
        .update(users)
        .set({ mfaEnabled: true, mfaMethod: method, updatedAt: new Date() })
        .where(eq(users.id, userId));

      await revokeAllUserSessions(userId);

      const actor = getAuditActor(request);
      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: userId,
          entityIdSnapshot: userId,
          action: 'mfa_enabled',
          ...actor,
          after: { mfaMethod: method },
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );

  const mfaDisableBody = z.object({
    password: z.string().min(1).describe('Current password for confirmation'),
  });

  app.delete(
    '/users/me/mfa',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Disable MFA',
        description:
          'Requires the user current password (verified via argon2), then clears mfaEnabled, mfaMethod, and the encrypted TOTP secret. The next login will skip the MFA challenge. Returns 401 if the password is wrong.',
        operationId: 'disableMfa',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaDisableBody),
        response: {
          200: successResponse,
          400: errorWith('Bad request', [ERROR_CODES.INVALID_PASSWORD, ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string; roleId: string };
      const { password } = request.body as z.infer<typeof mfaDisableBody>;

      const [user] = await db
        .select({
          passwordHash: users.passwordHash,
          mfaEnabled: users.mfaEnabled,
          mfaMethod: users.mfaMethod,
        })
        .from(users)
        .where(eq(users.id, userId));

      if (user == null) {
        await reply.status(400).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      const valid = await argon2.verify(user.passwordHash, password);
      if (!valid) {
        await reply.status(400).send({ error: 'Invalid password', code: 'INVALID_PASSWORD' });
        return;
      }

      await db
        .update(users)
        .set({
          mfaEnabled: false,
          mfaMethod: null,
          totpSecretEnc: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      await revokeAllUserSessions(userId);

      const actor = getAuditActor(request);
      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: userId,
          entityIdSnapshot: userId,
          action: 'mfa_disabled',
          ...actor,
          before: { mfaEnabled: user.mfaEnabled, mfaMethod: user.mfaMethod },
          after: { mfaEnabled: false, mfaMethod: null },
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );

  // --- AI Config endpoints ---

  const aiConfigResponse = z
    .object({
      configured: z.boolean().describe('Whether the user has saved a personal AI assistant config'),
      provider: z.string().nullable().describe('Selected AI provider (anthropic, openai, gemini)'),
      model: z.string().nullable().describe('Model override applied for this user'),
      temperature: z.number().nullable().describe('Generation temperature (0-2)'),
      topP: z.number().nullable().describe('Nucleus sampling threshold (0-1)'),
      topK: z.number().nullable().describe('Top-K token selection limit'),
      systemPrompt: z
        .string()
        .nullable()
        .describe('Custom system prompt that overrides the default'),
    })
    .passthrough();

  // --- Notification Preferences ---

  app.get(
    '/users/me/notification-preferences',
    {
      onRequest: [authorize('users:read')],
      schema: {
        tags: ['Users'],
        summary: 'Get operator notification preferences',
        operationId: 'getUserNotificationPreferences',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(
            z
              .object({
                smsEnabled: z
                  .boolean()
                  .describe('Whether the operator opted in to SMS notifications'),
              })
              .passthrough(),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const [prefs] = await db
        .select()
        .from(userNotificationPreferences)
        .where(eq(userNotificationPreferences.userId, userId));
      return { smsEnabled: prefs?.smsEnabled ?? true };
    },
  );

  app.put(
    '/users/me/notification-preferences',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Update operator notification preferences',
        operationId: 'updateUserNotificationPreferences',
        security: [{ bearerAuth: [] }],
        body: zodSchema(z.object({ smsEnabled: z.boolean() })),
        response: {
          200: itemResponse(
            z
              .object({
                smsEnabled: z
                  .boolean()
                  .describe('Whether the operator opted in to SMS notifications'),
              })
              .passthrough(),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const body = request.body as { smsEnabled: boolean };
      const [saved] = await db
        .insert(userNotificationPreferences)
        .values({ userId, smsEnabled: body.smsEnabled })
        .onConflictDoUpdate({
          target: [userNotificationPreferences.userId],
          set: { smsEnabled: body.smsEnabled, updatedAt: new Date() },
        })
        .returning();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return { smsEnabled: saved!.smsEnabled };
    },
  );

  app.get(
    '/users/me/chatbot-ai-config',
    {
      onRequest: [authorize('users:read')],
      schema: {
        tags: ['Users'],
        summary: 'Get personal AI configuration',
        operationId: 'getMyChatbotAiConfig',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(aiConfigResponse) },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string; roleId: string };

      const [row] = await db
        .select({
          provider: chatbotAiConfigs.provider,
          model: chatbotAiConfigs.model,
          temperature: chatbotAiConfigs.temperature,
          topP: chatbotAiConfigs.topP,
          topK: chatbotAiConfigs.topK,
          systemPrompt: chatbotAiConfigs.systemPrompt,
        })
        .from(chatbotAiConfigs)
        .where(eq(chatbotAiConfigs.userId, userId));

      if (row == null) {
        return {
          configured: false,
          provider: null,
          model: null,
          temperature: null,
          topP: null,
          topK: null,
          systemPrompt: null,
        };
      }

      return {
        configured: true,
        provider: row.provider,
        model: row.model ?? null,
        temperature: row.temperature != null ? Number(row.temperature) : null,
        topP: row.topP != null ? Number(row.topP) : null,
        topK: row.topK ?? null,
        systemPrompt: row.systemPrompt ?? null,
      };
    },
  );

  const aiConfigBody = z.object({
    provider: z.enum(['anthropic', 'openai', 'gemini']).describe('AI provider'),
    apiKey: z.string().min(1).describe('Provider API key'),
    model: z.string().optional().describe('Model override (leave empty for provider default)'),
    temperature: z.number().min(0).max(2).optional().describe('Sampling temperature (0-2)'),
    topP: z.number().min(0).max(1).optional().describe('Top-p sampling (0-1)'),
    topK: z.number().int().min(1).optional().describe('Top-k sampling'),
    systemPrompt: z.string().optional().describe('Custom system prompt'),
  });

  app.put(
    '/users/me/chatbot-ai-config',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Create or update personal AI configuration',
        operationId: 'updateMyChatbotAiConfig',
        security: [{ bearerAuth: [] }],
        body: zodSchema(aiConfigBody),
        response: { 200: successResponse },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string; roleId: string };
      const { provider, apiKey, model, temperature, topP, topK, systemPrompt } =
        request.body as z.infer<typeof aiConfigBody>;

      const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
      const apiKeyEnc = encryptString(apiKey, encKey);

      await db
        .insert(chatbotAiConfigs)
        .values({
          userId,
          provider,
          apiKeyEnc,
          model: model ?? null,
          temperature: temperature != null ? String(temperature) : null,
          topP: topP != null ? String(topP) : null,
          topK: topK ?? null,
          systemPrompt: systemPrompt ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: chatbotAiConfigs.userId,
          set: {
            provider,
            apiKeyEnc,
            model: model ?? null,
            temperature: temperature != null ? String(temperature) : null,
            topP: topP != null ? String(topP) : null,
            topK: topK ?? null,
            systemPrompt: systemPrompt ?? null,
            updatedAt: new Date(),
          },
        });

      return { success: true };
    },
  );

  app.delete(
    '/users/me/chatbot-ai-config',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Delete personal AI configuration',
        operationId: 'deleteMyChatbotAiConfig',
        security: [{ bearerAuth: [] }],
        response: { 200: successResponse },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string; roleId: string };

      await db.delete(chatbotAiConfigs).where(eq(chatbotAiConfigs.userId, userId));

      return { success: true };
    },
  );

  // --- Support AI Config endpoints ---

  const supportAiConfigResponse = z
    .object({
      configured: z.boolean().describe('Whether the user has saved a personal support AI config'),
      provider: z.string().nullable().describe('Selected AI provider for support case drafting'),
      model: z.string().nullable().describe('Model override applied for this user'),
      temperature: z.number().nullable().describe('Generation temperature (0-2)'),
      topP: z.number().nullable().describe('Nucleus sampling threshold (0-1)'),
      topK: z.number().nullable().describe('Top-K token selection limit'),
      systemPrompt: z
        .string()
        .nullable()
        .describe('Custom system prompt that overrides the default'),
      tone: z
        .string()
        .nullable()
        .describe('Tone preset used for drafting (professional, friendly, formal)'),
    })
    .passthrough();

  app.get(
    '/users/me/support-ai-config',
    {
      onRequest: [authorize('users:read')],
      schema: {
        tags: ['Users'],
        summary: 'Get personal support AI configuration',
        operationId: 'getMySupportAiConfig',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(supportAiConfigResponse) },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string; roleId: string };

      const [row] = await db
        .select({
          supportAiProvider: chatbotAiConfigs.supportAiProvider,
          supportAiModel: chatbotAiConfigs.supportAiModel,
          supportAiTemperature: chatbotAiConfigs.supportAiTemperature,
          supportAiTopP: chatbotAiConfigs.supportAiTopP,
          supportAiTopK: chatbotAiConfigs.supportAiTopK,
          supportAiSystemPrompt: chatbotAiConfigs.supportAiSystemPrompt,
          supportAiTone: chatbotAiConfigs.supportAiTone,
        })
        .from(chatbotAiConfigs)
        .where(eq(chatbotAiConfigs.userId, userId));

      if (row == null || row.supportAiProvider == null) {
        return {
          configured: false,
          provider: null,
          model: null,
          temperature: null,
          topP: null,
          topK: null,
          systemPrompt: null,
          tone: null,
        };
      }

      return {
        configured: true,
        provider: row.supportAiProvider,
        model: row.supportAiModel ?? null,
        temperature: row.supportAiTemperature != null ? Number(row.supportAiTemperature) : null,
        topP: row.supportAiTopP != null ? Number(row.supportAiTopP) : null,
        topK: row.supportAiTopK ?? null,
        systemPrompt: row.supportAiSystemPrompt ?? null,
        tone: row.supportAiTone ?? null,
      };
    },
  );

  const supportAiConfigBody = z.object({
    provider: z
      .enum(['anthropic', 'openai', 'gemini'])
      .describe('AI provider for support case assistance'),
    apiKey: z.string().min(1).describe('Provider API key'),
    model: z.string().optional().describe('Model override (leave empty for provider default)'),
    temperature: z.number().min(0).max(2).optional().describe('Sampling temperature (0-2)'),
    topP: z.number().min(0).max(1).optional().describe('Top-p sampling (0-1)'),
    topK: z.number().int().min(1).optional().describe('Top-k sampling'),
    systemPrompt: z.string().optional().describe('Custom system prompt for support AI'),
    tone: z
      .enum(['professional', 'friendly', 'formal'])
      .optional()
      .describe('Response tone — one of professional, friendly, formal'),
  });

  app.put(
    '/users/me/support-ai-config',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Create or update personal support AI configuration',
        operationId: 'updateMySupportAiConfig',
        security: [{ bearerAuth: [] }],
        body: zodSchema(supportAiConfigBody),
        response: { 200: successResponse },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string; roleId: string };
      const { provider, apiKey, model, temperature, topP, topK, systemPrompt, tone } =
        request.body as z.infer<typeof supportAiConfigBody>;

      const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
      const supportAiApiKeyEnc = encryptString(apiKey, encKey);

      const supportAiFields = {
        supportAiProvider: provider,
        supportAiApiKeyEnc,
        supportAiModel: model ?? null,
        supportAiTemperature: temperature != null ? String(temperature) : null,
        supportAiTopP: topP != null ? String(topP) : null,
        supportAiTopK: topK ?? null,
        supportAiSystemPrompt: systemPrompt ?? null,
        supportAiTone: tone ?? null,
        updatedAt: new Date(),
      };

      // Check if a row exists for this user
      const [existing] = await db
        .select({ id: chatbotAiConfigs.id })
        .from(chatbotAiConfigs)
        .where(eq(chatbotAiConfigs.userId, userId));

      if (existing != null) {
        // Update only support AI columns
        await db
          .update(chatbotAiConfigs)
          .set(supportAiFields)
          .where(eq(chatbotAiConfigs.userId, userId));
      } else {
        // Insert new row with support AI columns and placeholder general AI columns
        await db.insert(chatbotAiConfigs).values({
          userId,
          provider: provider,
          apiKeyEnc: '',
          ...supportAiFields,
        });
      }

      return { success: true };
    },
  );

  app.delete(
    '/users/me/support-ai-config',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Delete personal support AI configuration',
        operationId: 'deleteMySupportAiConfig',
        security: [{ bearerAuth: [] }],
        response: { 200: successResponse },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string; roleId: string };

      // Clear support AI columns
      const [row] = await db
        .select({
          provider: chatbotAiConfigs.provider,
          apiKeyEnc: chatbotAiConfigs.apiKeyEnc,
        })
        .from(chatbotAiConfigs)
        .where(eq(chatbotAiConfigs.userId, userId));

      if (row == null) {
        return { success: true };
      }

      // If general AI config is also empty, delete the whole row
      if (row.apiKeyEnc === '') {
        await db.delete(chatbotAiConfigs).where(eq(chatbotAiConfigs.userId, userId));
      } else {
        // Clear only support AI columns
        await db
          .update(chatbotAiConfigs)
          .set({
            supportAiProvider: null,
            supportAiApiKeyEnc: null,
            supportAiModel: null,
            supportAiTemperature: null,
            supportAiTopP: null,
            supportAiTopK: null,
            supportAiSystemPrompt: null,
            supportAiTone: null,
            updatedAt: new Date(),
          })
          .where(eq(chatbotAiConfigs.userId, userId));
      }

      return { success: true };
    },
  );

  // ------ Permission endpoints ------

  const permissionGroupItem = z
    .object({
      label: z.string().describe('Display label for the permission group'),
      permissions: z.array(z.string()).describe('Permission strings that belong to this group'),
    })
    .passthrough();

  const permissionsArraySchema = z.object({
    permissions: z
      .array(z.string())
      .min(0)
      .describe('Array of permission strings from the catalog'),
  });

  app.get(
    '/permissions',
    {
      onRequest: [authorize('users:read')],
      schema: {
        tags: ['Users'],
        summary: 'Get the permission catalog with groups',
        operationId: 'getPermissionCatalog',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(permissionGroupItem) },
      },
    },
    () => {
      return [...PERMISSION_GROUPS];
    },
  );

  app.get(
    '/users/me/permissions',
    {
      onRequest: [authorize('users:read')],
      schema: {
        tags: ['Users'],
        summary: 'Get current user permissions',
        operationId: 'getMyPermissions',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(z.string()) },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;

      const rows = await db
        .select({ permission: userPermissions.permission })
        .from(userPermissions)
        .where(eq(userPermissions.userId, userId));

      return rows.map((r) => r.permission);
    },
  );

  app.get(
    '/users/:id/permissions',
    {
      onRequest: [authorize('users:read')],
      schema: {
        tags: ['Users'],
        summary: 'Get a user permissions by user ID',
        operationId: 'getUserPermissions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(userParams),
        response: {
          200: arrayResponse(z.string()),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof userParams>;

      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));

      if (user == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      const rows = await db
        .select({ permission: userPermissions.permission })
        .from(userPermissions)
        .where(eq(userPermissions.userId, id));

      return rows.map((r) => r.permission);
    },
  );

  app.put(
    '/users/:id/permissions',
    {
      onRequest: [authorize('users:write')],
      schema: {
        tags: ['Users'],
        summary: 'Replace a user permissions',
        operationId: 'updateUserPermissions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(userParams),
        body: zodSchema(permissionsArraySchema),
        response: {
          200: arrayResponse(z.string()),
          400: errorWith('Invalid permissions', [ERROR_CODES.INVALID_PERMISSIONS]),
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof userParams>;
      const { permissions } = request.body as z.infer<typeof permissionsArraySchema>;

      // Cannot edit own permissions
      if (id === userId) {
        await reply
          .status(403)
          .send({ error: 'Cannot edit your own permissions', code: 'SELF_EDIT_FORBIDDEN' });
        return;
      }

      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));

      if (user == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      // Validate all permissions are in the catalog
      const catalogSet = new Set<string>(PERMISSIONS);
      const invalid = permissions.filter((p) => !catalogSet.has(p));
      if (invalid.length > 0) {
        await reply.status(400).send({
          error: `Invalid permissions: ${invalid.join(', ')}`,
          code: 'INVALID_PERMISSIONS',
        });
        return;
      }

      // Capture before-permissions for the audit row
      const beforePermRows = await db
        .select({ permission: userPermissions.permission })
        .from(userPermissions)
        .where(eq(userPermissions.userId, id));

      // Replace all permissions
      await db.delete(userPermissions).where(eq(userPermissions.userId, id));
      if (permissions.length > 0) {
        await db
          .insert(userPermissions)
          .values(permissions.map((p) => ({ userId: id, permission: p })))
          .onConflictDoNothing();
      }
      invalidatePermissionCache(id);

      const actor = getAuditActor(request);
      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'permissions_changed',
          ...actor,
          before: { permissions: beforePermRows.map((r) => r.permission) },
          after: { permissions },
        },
        db,
        request.log,
      );

      return permissions;
    },
  );
}
