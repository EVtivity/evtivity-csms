// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import crypto from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { eq, and, or, isNull, ilike, sql, inArray, desc, ne } from 'drizzle-orm';
import argon2 from 'argon2';
import { db, client, getMfaConfig, writeAudit, userAuditLog } from '@evtivity/database';
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
import { changedFields } from '../lib/audit-diff.js';
import {
  getNotificationSettings,
  sendEmail,
  wrapEmailHtml,
  renderTemplate,
  dispatchSystemNotification,
  decryptString,
  encryptString,
  generateTotpSecret,
  generateTotpUri,
  matchTotpStep,
  createMfaChallenge,
  verifyMfaChallenge,
  redactSensitiveNotificationContent,
  recordNotificationAttempt,
} from '@evtivity/lib';
import QRCode from 'qrcode';
import { clearAuthCookies, isSecureRequest, readRefreshCookie } from '../lib/auth-cookies.js';
import { checkRecaptcha } from '../lib/recaptcha-check.js';
import {
  validateAndRotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
  revokeAllUserSessions,
} from '../services/refresh-token.service.js';
import {
  announceSessionChange,
  bumpSessionVersion,
  endUserSessions,
  issueOperatorSession,
  passwordAuthBlocked,
  ssoManagedUser,
} from '../lib/operator-session.js';
import { sendPasswordChangedNotice } from '../lib/password-changed-notice.js';
import { verifyPassword } from '../lib/password-verify.js';
import {
  clearSignInFailures,
  acceptTotpStep,
  isLocked,
  mfaResendRetryAfter,
  recordSignInFailure,
  secondsUntil,
} from '../lib/sign-in-backoff.js';
import { applyUserDeactivation, revokeUserEmailLinks } from '../services/user-status.service.js';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { emailEquals } from '../lib/email-match.js';
import { verifyAgainstDummyHash } from '../lib/dummy-password-hash.js';
import { hasMfaContact, mfaCodeRecipient, removesSmsMfaPhone } from '../lib/mfa-contact.js';
import { generateUserToken, hashUserToken } from '../lib/user-token.js';
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
import { beginOperatorMfa } from '../lib/operator-mfa.js';
import { authorize, invalidatePermissionCache, selfService } from '../middleware/rbac.js';
import { invalidateUserActiveCache } from '../lib/user-active.js';
import { invalidateSiteAccessCache, assertSitesWithinScope } from '../lib/site-access.js';
import {
  canAdministerUser,
  canGrantPermissions,
  canManageUser,
  getUserManagementActor,
  manageableUsersCondition,
  roleDefaultPermissions,
} from '../lib/user-management-scope.js';
import { permissionCatalog, AI_EFFORTS, AI_PROVIDER_IDS, isAiEffort } from '@evtivity/lib';
import { isValidTimezone } from '@evtivity/lib/timezone';
import { validatePasswordComplexity } from '../lib/password-validation.js';
import { PASSWORD_MIN_LENGTH } from '@evtivity/lib/password-policy';
import { config as apiConfig } from '../lib/config.js';
import { recordAuthAudit } from '../lib/auth-audit.js';
import { storedSystemPrompt } from '../services/ai/engine/prompt-defaults.js';
import type { AiSurface } from '../services/ai/tools/policy.js';

/** Null for no personal prompt, including a saved but unchanged built-in one. */
function personalSystemPrompt(surface: AiSurface, text: string | undefined): string | null {
  const stored = text != null ? storedSystemPrompt(surface, text) : '';
  return stored.trim() === '' ? null : stored;
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = process.env['API_TEMPLATES_DIR'] ?? resolve(currentDir, '..', 'templates');
const OCPP_TEMPLATES_DIR =
  process.env['OCPP_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'ocpp', 'src', 'templates');
const ALL_TEMPLATES_DIRS = [OCPP_TEMPLATES_DIR, TEMPLATES_DIR];

const SMS_MFA_PHONE_REQUIRED = {
  error: 'The user signs in with SMS codes: turn them off before you remove the phone number',
  code: 'VALIDATION_ERROR',
} as const;

/** Whether the phone update would remove the phone the user's SMS second factor needs. */
async function smsMfaNeedsPhone(userId: string, nextPhone: string | null): Promise<boolean> {
  // A new number never locks anyone out: no read needed.
  if (nextPhone != null && nextPhone.trim() !== '') return false;
  const [row] = await db
    .select({ mfaEnabled: users.mfaEnabled, mfaMethod: users.mfaMethod })
    .from(users)
    .where(eq(users.id, userId));
  return row != null && removesSmsMfaPhone(nextPhone, row);
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
    .describe(
      'Site IDs to grant access to (ignored when hasAllSiteAccess is true). A site-restricted operator must give at least one of its own sites.',
    ),
});

const userParams = z.object({
  id: ID_PARAMS.userId.describe('User ID'),
});

// Restrict language to the locales the CSMS bundle ships translations for
// (frontend/i18n.md). An arbitrary string would persist and then break the
// i18n loader on the next session. Matches the portal driver enum.
const userLanguageEnum = z
  .enum(['en', 'de', 'es', 'ko', 'zh', 'zh-TW'])
  .describe('Preferred language code (one of the 6 CSMS-supported locales)');

const updateUserBody = z.object({
  email: z
    .string()
    .email()
    .max(255)
    .transform((v) => v.trim().toLowerCase())
    .optional()
    .describe('Sign-in email address, where password reset links go'),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().max(50).nullable().optional().describe('Mobile phone number'),
  roleId: ID_PARAMS.roleId.optional().describe('Role ID to assign to the user'),
  isActive: z.boolean().optional().describe('Whether the user account is active'),
  language: userLanguageEnum.optional(),
  timezone: z
    .string()
    .max(50)
    .optional()
    .describe(
      'IANA timezone (e.g. America/New_York). An unknown zone returns 400 VALIDATION_ERROR.',
    ),
  themePreference: z.enum(['light', 'dark']).optional(),
  hasAllSiteAccess: z.boolean().optional().describe('Whether the user can access all sites'),
  siteIds: z
    .array(z.string())
    .optional()
    .describe(
      'Site IDs to grant access to (replaces existing assignments). A site-restricted operator cannot send an empty list.',
    ),
});

// Self-edit body for /v1/users/me. Restricted to fields a user can change
// about themselves without triggering an RBAC permission check. roleId,
// isActive, hasAllSiteAccess, siteIds are intentionally excluded so a
// non-admin operator can save their own profile (the admin-only PATCH
// /v1/users/:id remains the only path to mutate those).
const updateMeBody = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().max(50).nullable().optional().describe('Mobile phone number'),
  language: userLanguageEnum.optional(),
  timezone: z
    .string()
    .max(50)
    .optional()
    .describe(
      'IANA timezone (e.g. America/New_York). An unknown zone returns 400 VALIDATION_ERROR.',
    ),
  themePreference: z.enum(['light', 'dark']).optional(),
});

const resetPasswordBody = z.object({
  password: z.string().min(PASSWORD_MIN_LENGTH),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH),
});

const forgotPasswordBody = z.object({
  email: z.string().email(),
  recaptchaToken: z.string().optional().describe('reCAPTCHA v3 token'),
});

const resetPasswordWithTokenBody = z.object({
  token: z.string().min(1).describe('Password reset token from email link'),
  password: z.string().min(PASSWORD_MIN_LENGTH),
});

const forceChangePasswordBody = z.object({
  email: z.string().email(),
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH),
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
  mfaEnabled: users.mfaEnabled,
  mfaMethod: users.mfaMethod,
  authSource: users.authSource,
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
    mfaEnabled: z.boolean().optional().describe('Whether the user signs in with a second factor'),
    mfaMethod: z
      .string()
      .nullable()
      .optional()
      .describe('Second factor method (email, sms, totp), null without MFA'),
    authSource: z
      .enum(['password', 'sso'])
      .optional()
      .describe('How the account was created: password, or sso (provisioned by an SSO sign-in)'),
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
    mfaEnabled: z.boolean().optional().describe('Whether the user signs in with a second factor'),
    mfaMethod: z
      .string()
      .nullable()
      .optional()
      .describe('Second factor method (email, sms, totp), null without MFA'),
    authSource: z
      .enum(['password', 'sso'])
      .optional()
      .describe('How the account was created: password, or sso (provisioned by an SSO sign-in)'),
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

type AiConfigKind = 'chatbot' | 'support';

/** A personal AI configuration as its audit row shows it: no key, only whether one is set. */
interface AiConfigState {
  fields: Record<string, unknown>;
  apiKeyEnc: string;
}

/** The user's personal chatbot or support AI configuration, null when not configured. */
async function readAiConfigState(
  userId: string,
  kind: AiConfigKind,
): Promise<AiConfigState | null> {
  const [row] = await db.select().from(chatbotAiConfigs).where(eq(chatbotAiConfigs.userId, userId));
  if (row == null) return null;
  if (kind === 'chatbot') {
    if (row.apiKeyEnc === '' || row.provider === '') return null;
    return {
      fields: {
        provider: row.provider,
        model: row.model ?? null,
        effort: row.effort ?? null,
        systemPrompt: row.systemPrompt ?? null,
      },
      apiKeyEnc: row.apiKeyEnc,
    };
  }
  if (row.supportAiApiKeyEnc == null || row.supportAiApiKeyEnc === '') return null;
  return {
    fields: {
      provider: row.supportAiProvider ?? null,
      model: row.supportAiModel ?? null,
      effort: row.supportAiEffort ?? null,
      systemPrompt: row.supportAiSystemPrompt ?? null,
      tone: row.supportAiTone ?? null,
    },
    apiKeyEnc: row.supportAiApiKeyEnc,
  };
}

/** Whether `apiKey` differs from the stored key. */
function aiKeyReplaced(stored: string, apiKey: string, encKey: string): boolean {
  try {
    return decryptString(stored, encKey) !== apiKey;
  } catch {
    // fail-open: a stored key this process cannot decrypt counts as replaced.
    return true;
  }
}

/**
 * `user.updated` audit row of a personal AI configuration change: the changed
 * fields only, and the API key as `set`, `replaced` or `unset`, never its
 * value. Nothing changed, no row. Fail-open (writeAudit).
 */
async function writeAiConfigAudit(
  request: FastifyRequest,
  userId: string,
  kind: AiConfigKind,
  before: AiConfigState | null,
  after: { fields: Record<string, unknown>; keyReplaced: boolean } | null,
): Promise<void> {
  const diff = changedFields(
    { configured: before != null, ...(before?.fields ?? {}) },
    { configured: after != null, ...(after?.fields ?? {}) },
  );
  if (before == null && after != null) {
    diff.before['apiKey'] = 'unset';
    diff.after['apiKey'] = 'set';
  } else if (before != null && after == null) {
    diff.before = { ...diff.before, ...before.fields, apiKey: 'set' };
    diff.after['apiKey'] = 'unset';
  } else if (after?.keyReplaced === true) {
    diff.before['apiKey'] = 'set';
    diff.after['apiKey'] = 'replaced';
  }
  if (Object.keys(diff.after).length === 0) return;
  await writeAudit(
    { table: userAuditLog, idColumn: 'user_id' },
    {
      entityId: userId,
      entityIdSnapshot: userId,
      action: 'updated',
      ...getAuditActor(request),
      before: diff.before,
      after: diff.after,
      notes: kind === 'chatbot' ? 'personal AI configuration' : 'personal support AI configuration',
    },
    db,
    request.log,
  );
}

export function userRoutes(app: FastifyInstance): void {
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
          400: errorWith('Bad request', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.RECAPTCHA_REQUIRED,
          ]),
          401: errorWith('Invalid credentials', [ERROR_CODES.INVALID_CREDENTIALS]),
          403: errorWith('Forbidden', [ERROR_CODES.ACCOUNT_DISABLED, ERROR_CODES.RECAPTCHA_FAILED]),
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

      const [user] = await db.select().from(users).where(emailEquals(users.email, email));

      if (user == null) {
        // Equalize timing with the user-exists branch so email enumeration
        // via response-time analysis fails.
        await verifyAgainstDummyHash(password);
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }

      // A locked account (sign-in backoff) and an SSO account while SSO is
      // enabled answer as for a wrong password, after the same time.
      const locked = isLocked(user.loginLockedUntil);
      if (locked || (await passwordAuthBlocked(user))) {
        await verifyAgainstDummyHash(password);
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'password',
          reason: locked ? 'locked' : 'sso_account',
        });
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }

      const valid = await verifyPassword(user.passwordHash, password, request.log);
      if (!valid) {
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'password',
          reason: 'bad_password',
        });
        await recordSignInFailure(request, user.id, 'password');
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }
      await clearSignInFailures(user.id, 'password');

      if (!user.isActive) {
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'password',
          reason: 'inactive',
        });
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      if (user.mustResetPassword) {
        await reply.status(200).send({ mustResetPassword: true });
        return;
      }

      // MFA check
      const mfaPending = await beginOperatorMfa(app, user);
      if (mfaPending != null) return mfaPending;

      const [role] = await db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(eq(roles.id, user.roleId));

      const token = await issueOperatorSession(app, request, reply, user);

      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      await recordAuthAudit(request, {
        kind: 'user',
        accountId: user.id,
        action: 'login_succeeded',
        method: 'password',
      });

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
      onRequest: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Logout and clear auth cookies',
        operationId: 'logout',
        security: [{ bearerAuth: [] }],
        response: { 200: successResponse },
      },
    },
    async (request, reply) => {
      const refreshCookie = readRefreshCookie('csms', request);
      if (refreshCookie.status === 'valid') {
        await revokeRefreshToken(refreshCookie.value);
      }
      // Clear cached permissions for the logged-out user, and end the access
      // tokens issued before (session version). An API key signs nothing out.
      const jwtUser = request.user as JwtPayload;
      if (jwtUser.isApiKey !== true) {
        invalidatePermissionCache(jwtUser.userId);
        await bumpSessionVersion(jwtUser.userId);
        announceSessionChange(jwtUser.userId);
      }
      clearAuthCookies('csms', reply, isSecureRequest(request));
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
      const refreshCookie = readRefreshCookie('csms', request);
      if (refreshCookie.status === 'absent') {
        await reply.status(401).send({ error: 'No refresh token', code: 'NO_REFRESH_TOKEN' });
        return;
      }

      const result =
        refreshCookie.status === 'valid'
          ? await validateAndRotateRefreshToken(refreshCookie.value)
          : null;
      if (result == null || result.userId == null) {
        clearAuthCookies('csms', reply, isSecureRequest(request));
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
          sessionVersion: users.sessionVersion,
        })
        .from(users)
        .where(eq(users.id, result.userId));

      if (!user || !user.isActive) {
        clearAuthCookies('csms', reply, isSecureRequest(request));
        await reply.status(401).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      await issueOperatorSession(app, request, reply, user);

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
      // operator emails by triggering reset emails for any account.
      const recaptchaOk = await checkRecaptcha(recaptchaToken, reply);
      if (!recaptchaOk) return;

      const [user] = await db
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          language: users.language,
          isActive: users.isActive,
          authSource: users.authSource,
        })
        .from(users)
        .where(emailEquals(users.email, email));

      // An inactive account and an SSO account while SSO is enabled get no
      // link, with the same answer as an unknown email.
      if (user != null && user.isActive && !(await passwordAuthBlocked(user))) {
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
        const { raw: rawToken, hash: tokenHash } = generateUserToken();

        await db.insert(userTokens).values({
          userId: user.id,
          tokenHash,
          type: 'password_reset',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });

        // Send email
        const csmsUrl = apiConfig.CSMS_URL;
        const resetUrl = `${csmsUrl}/reset-password?token=${rawToken}`;

        // Not awaited: the answer for a known email must not wait for the
        // mail provider, or its time would tell the email exists.
        void (async () => {
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
            const storedBody = redactSensitiveNotificationContent(
              wrappedHtml ?? rendered.body,
              'operator.ForgotPassword',
            );
            const storedSubject = redactSensitiveNotificationContent(
              rendered.subject,
              'operator.ForgotPassword',
            );
            // Match the dispatchSystemNotification pattern so operators can
            // see in the Email Log why a forgot-password mail failed.
            const metadata: Record<string, string> = {};
            if (!ok) {
              metadata['failureReason'] =
                settings.smtp.credentialError === 'decrypt_failed'
                  ? 'credentials_decrypt_failed'
                  : 'smtp_send_failed';
            }
            await recordNotificationAttempt(client, {
              channel: 'email',
              recipient: email,
              subject: storedSubject,
              body: storedBody,
              status: ok ? 'sent' : 'failed',
              eventType: 'operator.ForgotPassword',
              metadata,
            });
          }
        })().catch((err: unknown) => {
          // fail-open: the answer is the same either way, so it does not
          // reveal whether the user exists (P9).
          request.log.warn({ err }, 'Password reset email dispatch failed');
        });
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
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const { token, password } = request.body as z.infer<typeof resetPasswordWithTokenBody>;

      const complexityError = validatePasswordComplexity(password);
      if (complexityError != null) {
        await reply.status(400).send({ error: complexityError, code: 'WEAK_PASSWORD' });
        return;
      }

      // Hash before the lookup: the time does not depend on the link.
      const passwordHash = await argon2.hash(password);
      const tokenHash = hashUserToken(token);

      // One transaction: the guarded consume (a link works once, the first of
      // two parallel requests wins) and the password write. A link of an
      // inactive user, or of an SSO account while SSO is enabled, stays used
      // and sets nothing.
      const outcome = await db.transaction(async (tx) => {
        const [consumed] = await tx
          .update(userTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(userTokens.tokenHash, tokenHash),
              eq(userTokens.type, 'password_reset'),
              isNull(userTokens.revokedAt),
              sql`${userTokens.expiresAt} > now()`,
            ),
          )
          .returning({ userId: userTokens.userId });
        if (consumed?.userId == null) return null;
        const [user] = await tx
          .select({ isActive: users.isActive, authSource: users.authSource })
          .from(users)
          .where(eq(users.id, consumed.userId));
        if (user == null || !user.isActive || (await passwordAuthBlocked(user))) return null;
        const [updated] = await tx
          .update(users)
          .set({
            passwordHash,
            mustResetPassword: false,
            failedLoginCount: 0,
            loginLockedUntil: null,
            sessionVersion: sql`${users.sessionVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(users.id, consumed.userId), eq(users.isActive, true)))
          .returning({ id: users.id });
        if (updated == null) return null;
        // Other open links of the user end with this one.
        await revokeUserEmailLinks(updated.id, tx);
        return updated.id;
      });

      if (outcome == null) {
        await reply
          .status(400)
          .send({ error: 'Invalid or expired reset link', code: 'INVALID_TOKEN' });
        return;
      }

      // Forgot-password is the recovery path after credential compromise:
      // revoke every refresh token and API key, so a stolen session cookie or
      // key stops working after the legitimate user completes the reset.
      // The session version moved in the transaction.
      await revokeAllUserRefreshTokens(outcome);
      announceSessionChange(outcome);

      await recordAuthAudit(request, {
        kind: 'user',
        accountId: outcome,
        action: 'password_reset',
        method: 'reset_token',
      });

      sendPasswordChangedNotice(outcome, request.log);

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

      const [user] = await db.select().from(users).where(emailEquals(users.email, email));

      // The password is checked first (against a dummy hash for an unknown
      // email), and every refusal answers the same 401, so the route tells
      // nothing about the account: not whether it exists, is active, needs
      // a reset, is locked or signs in with SSO.
      const locked = user != null && isLocked(user.loginLockedUntil);
      const valid =
        user != null && !locked
          ? await verifyPassword(user.passwordHash, currentPassword, request.log)
          : await verifyAgainstDummyHash(currentPassword);
      const refusal =
        user == null
          ? 'unknown'
          : locked
            ? 'locked'
            : !valid
              ? 'bad_password'
              : !user.isActive
                ? 'inactive'
                : !user.mustResetPassword
                  ? 'reset_not_required'
                  : (await passwordAuthBlocked(user))
                    ? 'sso_account'
                    : null;
      if (user == null || refusal != null) {
        if (user != null && refusal != null) {
          await recordAuthAudit(request, {
            kind: 'user',
            accountId: user.id,
            action: 'login_failed',
            method: 'password',
            reason: refusal,
          });
          if (refusal === 'bad_password') await recordSignInFailure(request, user.id, 'password');
        }
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }
      await clearSignInFailures(user.id, 'password');

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

      // End every existing session before issuing the new one (session
      // version and refresh tokens). API keys stay: the user changed the
      // password, nobody reset it.
      const sessionVersion = (await endUserSessions(user.id, { apiKeys: false })) ?? 0;
      sendPasswordChangedNotice(user.id, request.log);

      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: user.id,
          entityIdSnapshot: user.id,
          action: 'password_reset',
          // The request is not authenticated: the user proved the account
          // with the current password, so the user is the actor.
          actor: 'operator',
          actorUserId: user.id,
          notes: 'User changed own password (forced reset)',
        },
        db,
        request.log,
      );

      // If MFA is enabled, an admin-initiated forced reset must not be a
      // bypass: hand back an mfaToken and require the user to complete the
      // existing /auth/mfa/verify flow before getting a real session. The
      // login handler does the same thing for normal logins; we route the
      // forced-reset path through the same gate.
      const mfaPending = await beginOperatorMfa(app, user);
      if (mfaPending != null) return mfaPending;

      const [role] = await db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(eq(roles.id, user.roleId));

      const token = await issueOperatorSession(app, request, reply, { ...user, sessionVersion });

      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      await recordAuthAudit(request, {
        kind: 'user',
        accountId: user.id,
        action: 'login_succeeded',
        method: 'password',
      });

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
      onRequest: [selfService({ allowApiKey: true })],
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

  app.patch(
    '/users/me',
    {
      onRequest: [selfService()],
      schema: {
        tags: ['Users'],
        summary: 'Update the authenticated user&#39;s own profile fields',
        description:
          'Self-service update of safe profile fields (name, phone, language, timezone, theme). Auth-only, not RBAC-gated, so non-admin operators can save their own Profile page without holding the users:write permission. Sensitive fields (roleId, isActive, hasAllSiteAccess, siteIds) are intentionally not part of this body; admins use PATCH /v1/users/:id for those.',
        operationId: 'updateCurrentUser',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateMeBody),
        response: {
          200: itemResponse(userWithRole),
          400: errorWith(
            'Invalid timezone, or the phone of an SMS second factor cannot be removed',
            [ERROR_CODES.VALIDATION_ERROR],
          ),
          403: errorWith('API keys cannot change the profile', [ERROR_CODES.SESSION_REQUIRED]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const body = request.body as z.infer<typeof updateMeBody>;

      // An unknown zone would make every date in the user's notices throw.
      if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
        await reply.status(400).send({ error: 'Invalid IANA timezone', code: 'VALIDATION_ERROR' });
        return;
      }

      if (body.phone !== undefined && (await smsMfaNeedsPhone(userId, body.phone))) {
        await reply.status(400).send(SMS_MFA_PHONE_REQUIRED);
        return;
      }

      const fields: Record<string, unknown> = { updatedAt: new Date() };
      if (body.firstName !== undefined) fields['firstName'] = body.firstName;
      if (body.lastName !== undefined) fields['lastName'] = body.lastName;
      if (body.phone !== undefined) fields['phone'] = body.phone;
      if (body.language !== undefined) fields['language'] = body.language;
      if (body.timezone !== undefined) fields['timezone'] = body.timezone;
      if (body.themePreference !== undefined) fields['themePreference'] = body.themePreference;

      const [before] = await db.select(userSelect).from(users).where(eq(users.id, userId));
      const [updated] = await db
        .update(users)
        .set(fields)
        .where(eq(users.id, userId))
        .returning(userSelect);

      if (updated == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      const actor = getAuditActor(request);
      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: userId,
          entityIdSnapshot: userId,
          action: 'updated',
          ...actor,
          before,
          after: updated,
        },
        db,
        request.log,
      );

      const [role] = updated.roleId
        ? await db
            .select({ id: roles.id, name: roles.name })
            .from(roles)
            .where(eq(roles.id, updated.roleId))
        : [];

      return { ...updated, role: role ?? null };
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

      // A site-restricted operator sees only users within its sites.
      const actor = await getUserManagementActor(request);
      const conditions = [];
      const scope = manageableUsersCondition(actor.siteIds);
      if (scope != null) conditions.push(scope);
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
        db
          .select(userSelect)
          .from(users)
          .where(where)
          .orderBy(desc(users.createdAt), desc(users.id))
          .limit(limit)
          .offset(offset),
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
          403: errorWith('Grant exceeds own access', [
            ERROR_CODES.FORBIDDEN,
            ERROR_CODES.PERMISSIONS_EXCEED_OWN,
          ]),
          409: errorWith('Email already in use', [ERROR_CODES.DUPLICATE_EMAIL]),
        },
      },
    },
    async (request, reply) => {
      const body = parseZodRequest(createUserBody, request.body);
      const actor = await getUserManagementActor(request);

      // A site-restricted operator never grants access to every site.
      if (body.hasAllSiteAccess && actor.siteIds != null) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }
      // A site-restricted operator assigns at least one of its sites: a user
      // without a site would be invisible to it.
      if (actor.siteIds != null && (body.siteIds == null || body.siteIds.length === 0)) {
        await reply
          .status(400)
          .send({ error: 'At least one site is required', code: 'INVALID_SITE_IDS' });
        return;
      }

      // Pre-check the unique email constraint (case-insensitive) so we return
      // a clean 409 instead of letting Postgres raise a 500. Body email is
      // lowercased + trimmed by the Zod transform on createUserBody.
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(emailEquals(users.email, body.email))
        .limit(1);
      if (existing != null) {
        await reply.status(409).send({ error: 'Email already in use', code: 'DUPLICATE_EMAIL' });
        return;
      }

      // Pre-validate roleId so a bad FK returns a clean 400 instead of a
      // Postgres FK violation surfaced as 500.
      const [role] = await db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(eq(roles.id, body.roleId))
        .limit(1);
      if (role == null) {
        await reply.status(400).send({ error: 'Role does not exist', code: 'ROLE_NOT_FOUND' });
        return;
      }
      // The new user gets the role's default permissions: an operator may
      // only pick a role whose defaults it holds itself.
      if (!(await canGrantPermissions(request, roleDefaultPermissions(role.name)))) {
        await reply.status(403).send({
          error: 'Permissions must be a subset of your own permissions',
          code: 'PERMISSIONS_EXCEED_OWN',
        });
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
        // A site outside a restricted operator's sites answers like an
        // unknown one, so its existence does not leak.
        if (
          found.length !== createSiteIds.length ||
          !(await assertSitesWithinScope(actor.userId, createSiteIds))
        ) {
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

      const roleDefaults = permissionCatalog.defaultsFor(createdRole?.name);

      if (roleDefaults.length > 0) {
        await db
          .insert(userPermissions)
          .values(roleDefaults.map((p) => ({ userId: user.id, permission: p })))
          .onConflictDoNothing();
      }

      // Generate 24-hour password setup token
      const { raw: rawToken, hash: tokenHash } = generateUserToken();

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

      const auditActor = getAuditActor(request);
      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: user.id,
          entityIdSnapshot: user.id,
          action: 'created',
          ...auditActor,
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

      if (user == null || !(await canManageUser(await getUserManagementActor(request), id))) {
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
          403: errorWith('Self edit forbidden or grant exceeds own access', [
            ERROR_CODES.SELF_EDIT_FORBIDDEN,
            ERROR_CODES.FORBIDDEN,
            ERROR_CODES.PERMISSIONS_EXCEED_OWN,
          ]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
          409: errorWith('Email already in use', [ERROR_CODES.DUPLICATE_EMAIL]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof userParams>;
      // Parsed here so the email transform (trim, lowercase) runs.
      const body = parseZodRequest(updateUserBody, request.body);

      // An unknown zone would make every date in the user's notices throw.
      if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
        await reply.status(400).send({ error: 'Invalid IANA timezone', code: 'VALIDATION_ERROR' });
        return;
      }

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

      // A site-restricted operator manages only users within its sites. Any
      // other user answers like a missing one.
      const actor = await getUserManagementActor(request);
      // Account changes (status, role, site access, the MFA phone, the email
      // that receives password reset links) also need the target's
      // permissions within the actor's own; the profile fields (name,
      // language, timezone, theme) need the site scope only.
      const changesAccount =
        body.isActive !== undefined ||
        body.roleId !== undefined ||
        body.hasAllSiteAccess !== undefined ||
        body.siteIds !== undefined ||
        body.phone !== undefined ||
        body.email !== undefined;
      const [before] = await db.select(userSelect).from(users).where(eq(users.id, id));
      const allowed =
        before != null &&
        (changesAccount
          ? await canAdministerUser(request, actor, id)
          : await canManageUser(actor, id));
      if (!allowed) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      // A site-restricted operator never grants access to every site.
      if (body.hasAllSiteAccess === true && actor.siteIds != null) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }
      // A site-restricted operator never removes every site of a user: the
      // user would become invisible to it.
      if (actor.siteIds != null && body.siteIds !== undefined && body.siteIds.length === 0) {
        await reply
          .status(400)
          .send({ error: 'At least one site is required', code: 'INVALID_SITE_IDS' });
        return;
      }

      // SMS codes need the phone: removing it would lock the user out.
      if (body.phone !== undefined && (await smsMfaNeedsPhone(id, body.phone))) {
        await reply.status(400).send(SMS_MFA_PHONE_REQUIRED);
        return;
      }

      // The unique email constraint is case-insensitive: answer a clean 409
      // instead of a Postgres error.
      const emailChanged = body.email !== undefined && body.email !== before.email.toLowerCase();
      if (emailChanged && body.email !== undefined) {
        const [taken] = await db
          .select({ id: users.id })
          .from(users)
          .where(and(emailEquals(users.email, body.email), ne(users.id, id)))
          .limit(1);
        if (taken != null) {
          await reply.status(409).send({ error: 'Email already in use', code: 'DUPLICATE_EMAIL' });
          return;
        }
      }

      // Pre-validate roleId FK so a bad role returns a clean 400 instead
      // of a Postgres FK violation surfaced as 500. A role change resets the
      // user's permissions to the role defaults, so a site-restricted
      // operator may only pick a role whose defaults it holds itself.
      let newRoleDefaults: string[] = [];
      if (body.roleId !== undefined) {
        const [role] = await db
          .select({ id: roles.id, name: roles.name })
          .from(roles)
          .where(eq(roles.id, body.roleId))
          .limit(1);
        if (role == null) {
          await reply.status(400).send({ error: 'Role does not exist', code: 'ROLE_NOT_FOUND' });
          return;
        }
        newRoleDefaults = roleDefaultPermissions(role.name);
        if (!(await canGrantPermissions(request, newRoleDefaults))) {
          await reply.status(403).send({
            error: 'Permissions must be a subset of your own permissions',
            code: 'PERMISSIONS_EXCEED_OWN',
          });
          return;
        }
      }

      // Pre-validate site assignments before any write, so a bad siteId
      // returns a clean 400 instead of a Postgres FK violation surfaced as
      // 500. A site outside a restricted operator's sites answers like an
      // unknown one. Dedupe the input so duplicates don't trip the
      // (userId, siteId) UNIQUE constraint on insert.
      const patchSiteIds = body.siteIds === undefined ? undefined : [...new Set(body.siteIds)];
      if (patchSiteIds != null && patchSiteIds.length > 0) {
        const found = await db
          .select({ id: sites.id })
          .from(sites)
          .where(inArray(sites.id, patchSiteIds));
        if (
          found.length !== patchSiteIds.length ||
          !(await assertSitesWithinScope(actor.userId, patchSiteIds))
        ) {
          await reply
            .status(400)
            .send({ error: 'One or more siteIds do not exist', code: 'INVALID_SITE_IDS' });
          return;
        }
      }

      const fields: Record<string, unknown> = { updatedAt: new Date() };
      if (body.email !== undefined) fields['email'] = body.email;
      if (body.firstName !== undefined) fields['firstName'] = body.firstName;
      if (body.lastName !== undefined) fields['lastName'] = body.lastName;
      if (body.phone !== undefined) fields['phone'] = body.phone;
      if (body.roleId !== undefined) fields['roleId'] = body.roleId;
      if (body.isActive !== undefined) fields['isActive'] = body.isActive;
      if (body.language !== undefined) fields['language'] = body.language;
      if (body.timezone !== undefined) fields['timezone'] = body.timezone;
      if (body.themePreference !== undefined) fields['themePreference'] = body.themePreference;
      if (body.hasAllSiteAccess !== undefined) fields['hasAllSiteAccess'] = body.hasAllSiteAccess;

      // One transaction: the user row, its site assignments and its
      // permissions change together or not at all.
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(users)
          .set(fields)
          .where(eq(users.id, id))
          .returning(userSelect);
        if (row == null) return null;

        // Reset and invite links already sent went to the old address.
        if (emailChanged) await revokeUserEmailLinks(id, tx);

        // A role change ends the access tokens issued under the old role.
        if (body.roleId !== undefined) await bumpSessionVersion(id, tx);

        if (patchSiteIds !== undefined) {
          await tx.delete(userSiteAssignments).where(eq(userSiteAssignments.userId, id));
          if (patchSiteIds.length > 0) {
            await tx
              .insert(userSiteAssignments)
              .values(patchSiteIds.map((siteId) => ({ userId: id, siteId })));
          }
        }

        // Reset permissions to the new role defaults when roleId changes
        if (body.roleId !== undefined) {
          await tx.delete(userPermissions).where(eq(userPermissions.userId, id));
          if (newRoleDefaults.length > 0) {
            await tx
              .insert(userPermissions)
              .values(newRoleDefaults.map((p) => ({ userId: id, permission: p })))
              .onConflictDoNothing();
          }
        }
        return row;
      });

      if (updated == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      // Invalidate site access cache when site access fields change
      if (body.hasAllSiteAccess !== undefined || body.siteIds !== undefined) {
        invalidateSiteAccessCache(id);
      }

      // Deactivation: end every session, API key and emailed link at once
      // (user-status.service.ts), not after the cache window plus the JWT
      // lifetime. Run for every isActive: false, so a retry completes a
      // failed step.
      if (body.isActive === false) {
        await applyUserDeactivation(id, { log: request.log });
      } else if (body.isActive === true) {
        invalidateUserActiveCache(id);
      }

      if (body.roleId !== undefined) {
        invalidatePermissionCache(id);
        await revokeAllUserSessions(id);
        announceSessionChange(id);
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

      const auditActor = getAuditActor(request);
      let action: string = 'updated';
      if (body.roleId !== undefined && body.roleId !== before.roleId) {
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
          ...auditActor,
          before,
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
          409: errorWith('The user signs in with SSO', [ERROR_CODES.USER_SSO_MANAGED]),
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

      if (!(await canAdministerUser(request, await getUserManagementActor(request), id))) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      if (await ssoManagedUser(id)) {
        await reply
          .status(409)
          .send({ error: 'The user signs in with SSO', code: 'USER_SSO_MANAGED' });
        return;
      }

      const passwordHash = await argon2.hash(password);

      const [updated] = await db
        .update(users)
        .set({
          passwordHash,
          mustResetPassword: true,
          failedLoginCount: 0,
          loginLockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, id))
        .returning({ id: users.id });

      if (updated == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      // A reset by an admin ends every session and API key of the user, and
      // tells the user.
      await endUserSessions(updated.id, { apiKeys: true });
      sendPasswordChangedNotice(updated.id, request.log);

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
      onRequest: [selfService()],
      // A stolen session must not brute-force the current password.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Users'],
        summary: 'Change the current user password',
        operationId: 'changePassword',
        security: [{ bearerAuth: [] }],
        body: zodSchema(changePasswordBody),
        response: {
          200: successResponse,
          400: errorWith('Weak password', [
            ERROR_CODES.WEAK_PASSWORD,
            ERROR_CODES.INVALID_PASSWORD,
          ]),
          403: errorWith('API keys cannot change the password', [ERROR_CODES.SESSION_REQUIRED]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string; roleId: string };
      const { currentPassword, newPassword } = request.body as z.infer<typeof changePasswordBody>;

      const [user] = await db
        .select({
          id: users.id,
          roleId: users.roleId,
          passwordHash: users.passwordHash,
          authSource: users.authSource,
        })
        .from(users)
        .where(eq(users.id, userId));

      if (user == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      // An SSO account while SSO is enabled has no password to change: it
      // answers as for a wrong current password.
      const valid =
        (await verifyPassword(user.passwordHash, currentPassword, request.log)) &&
        !(await passwordAuthBlocked(user));
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

      // End every session (other devices included), keep the API keys (a
      // voluntary change), and give this browser a new session.
      const sessionVersion = (await endUserSessions(userId, { apiKeys: false })) ?? 0;
      await issueOperatorSession(app, request, reply, { ...user, sessionVersion });
      sendPasswordChangedNotice(userId, request.log);

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
      if (
        user == null ||
        !(await canAdministerUser(request, await getUserManagementActor(request), id))
      ) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      await db
        .update(users)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(users.id, id));

      await applyUserDeactivation(id, { log: request.log });

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
          409: errorWith('The user signs in with SSO', [ERROR_CODES.USER_SSO_MANAGED]),
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
          language: users.language,
        })
        .from(users)
        .where(eq(users.id, id));

      if (
        user == null ||
        !(await canAdministerUser(request, await getUserManagementActor(request), id))
      ) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }
      if (!user.isActive) {
        // No point sending a setup email to an account that can't log in.
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }
      if (await ssoManagedUser(id)) {
        await reply
          .status(409)
          .send({ error: 'The user signs in with SSO', code: 'USER_SSO_MANAGED' });
        return;
      }

      await revokeUserEmailLinks(user.id);

      // Generate new 24-hour token
      const { raw: rawToken, hash: tokenHash } = generateUserToken();

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
        {
          email: user.email,
          phone: user.phone ?? undefined,
          userId: user.id,
          language: user.language,
        },
        {
          firstName: user.firstName ?? '',
          lastName: user.lastName ?? '',
          email: user.email,
          setPasswordUrl,
        },
        ALL_TEMPLATES_DIRS,
      );

      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: user.id,
          entityIdSnapshot: user.id,
          action: 'invite_resent',
          ...getAuditActor(request),
          after: { email: user.email },
        },
        db,
        request.log,
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
            ERROR_CODES.MFA_CODE_INVALID,
            ERROR_CODES.MFA_NOT_CONFIGURED,
            ERROR_CODES.MFA_TOKEN_INVALID,
            ERROR_CODES.TOTP_NOT_CONFIGURED,
          ]),
          401: errorWith('Unauthorized', [ERROR_CODES.UNAUTHORIZED, ERROR_CODES.MFA_TOKEN_EXPIRED]),
          403: errorWith('Account disabled', [ERROR_CODES.ACCOUNT_DISABLED]),
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
      const { mfaToken, code, challengeId } = request.body as z.infer<typeof mfaVerifyBody>;

      let payload: { userId: string; roleId: string; mfaPending?: boolean };
      try {
        payload = app.jwt.verify(mfaToken);
      } catch (err) {
        request.log.debug({ err }, 'MFA token did not verify, refusing it');
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
      if (!user.isActive) {
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'mfa',
          reason: 'inactive',
        });
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      // Per-account backoff after repeated wrong codes (sign-in-backoff.ts).
      if (user.mfaLockedUntil != null && isLocked(user.mfaLockedUntil)) {
        const retryAfterSeconds = secondsUntil(user.mfaLockedUntil);
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
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
      if (user.mfaMethod === 'totp') {
        if (user.totpSecretEnc == null) {
          await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
          return;
        }
        const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
        let step: number | null = null;
        try {
          const secret = decryptString(user.totpSecretEnc, encKey);
          step = matchTotpStep(secret, code);
        } catch (err: unknown) {
          // Stored TOTP secret cannot be decrypted (e.g. SETTINGS_ENCRYPTION_KEY
          // rotated, ciphertext corrupted). Surface as a clean MFA failure
          // rather than a 500, but log the underlying error for ops.
          request.log.warn({ err, userId: payload.userId }, 'TOTP secret decrypt failed');
        }
        // A code is accepted once (replay guard, sign-in-backoff.ts).
        if (step != null) verified = await acceptTotpStep(user.id, step);
      } else if (challengeId != null) {
        // Tries are counted on the challenge row (MFA_CHALLENGE_MAX_ATTEMPTS),
        // shared by every API process, and the challenge is single use.
        const result = await verifyMfaChallenge(client, challengeId, code, { userId: user.id });
        verified = result === 'verified';
        exhausted = result === 'exhausted';
      }

      if (!verified) {
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'mfa',
          reason: exhausted ? 'mfa_challenge_exhausted' : 'mfa_code_invalid',
        });
        await recordSignInFailure(request, user.id, 'mfa');
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
      await clearSignInFailures(user.id, 'mfa');

      const [role] = await db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(eq(roles.id, user.roleId));

      const token = await issueOperatorSession(app, request, reply, user);
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      await recordAuthAudit(request, {
        kind: 'user',
        accountId: user.id,
        action: 'login_succeeded',
        method: 'mfa',
      });

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
            ERROR_CODES.MFA_TOTP_NO_RESEND,
          ]),
          401: errorWith('Unauthorized', [ERROR_CODES.UNAUTHORIZED, ERROR_CODES.MFA_TOKEN_EXPIRED]),
          403: errorWith('Account disabled', [ERROR_CODES.ACCOUNT_DISABLED]),
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

      let payload: { userId: string; roleId: string; mfaPending?: boolean };
      try {
        payload = app.jwt.verify(mfaToken);
      } catch (err) {
        request.log.debug({ err }, 'MFA token did not verify, refusing it');
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

      if (!user.isActive) {
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }

      if (user.mfaMethod === 'totp') {
        await reply
          .status(400)
          .send({ error: 'Cannot resend TOTP codes', code: 'MFA_TOTP_NO_RESEND' });
        return;
      }

      // A cap on the codes sent to one user (sign-in-backoff.ts), counted
      // from the challenge rows so every process sees the same count.
      const retryAfterSeconds = await mfaResendRetryAfter(user.id);
      if (retryAfterSeconds != null) {
        void reply.header('Retry-After', String(retryAfterSeconds));
        await reply.status(429).send({
          error: 'Too many codes sent. Try again later.',
          code: 'MFA_RESEND_LIMITED',
          retryAfterSeconds,
        });
        return;
      }

      const challenge = await createMfaChallenge(client, {
        userId: user.id,
        method: user.mfaMethod,
      });

      await dispatchSystemNotification(
        client,
        'mfa.VerificationCode',
        mfaCodeRecipient(user.mfaMethod, user),
        { code: challenge.code },
        TEMPLATES_DIR,
      );

      return { challengeId: challenge.challengeId };
    },
  );

  // Admin MFA reset: for a user who lost the authenticator or phone. The
  // user signs in with the password alone and can set MFA up again.
  app.post(
    '/users/:id/mfa/reset',
    {
      onRequest: [authorize('users:write')],
      schema: {
        tags: ['Users'],
        summary: 'Turn off the MFA of a user',
        description:
          'Clears the MFA method and TOTP secret of the user, ends every session of the user (API keys stay) and writes an mfa_reset audit row. For a user who lost the second factor. Requires users:write and every permission of the target user. Never available to the AI assistant or MCP.',
        operationId: 'resetUserMfa',
        security: [{ bearerAuth: [] }],
        params: zodSchema(userParams),
        response: {
          200: successResponse,
          403: errorWith('Self edit forbidden', [ERROR_CODES.SELF_EDIT_FORBIDDEN]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof userParams>;
      const { userId: actorUserId } = request.user as JwtPayload;

      // An operator changes its own MFA on its profile, with its password.
      if (id === actorUserId) {
        await reply
          .status(403)
          .send({ error: 'Use your profile to change your MFA', code: 'SELF_EDIT_FORBIDDEN' });
        return;
      }

      const [before] = await db
        .select({ id: users.id, mfaEnabled: users.mfaEnabled, mfaMethod: users.mfaMethod })
        .from(users)
        .where(eq(users.id, id));
      if (
        before == null ||
        !(await canAdministerUser(request, await getUserManagementActor(request), id))
      ) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      await db
        .update(users)
        .set({
          mfaEnabled: false,
          mfaMethod: null,
          totpSecretEnc: null,
          totpLastStep: null,
          mfaFailedCount: 0,
          mfaLockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, id));
      await endUserSessions(id, { apiKeys: false });

      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'mfa_reset',
          ...getAuditActor(request),
          before: { mfaEnabled: before.mfaEnabled, mfaMethod: before.mfaMethod },
          after: { mfaEnabled: false, mfaMethod: null },
        },
        db,
        request.log,
      );

      return { success: true };
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
      onRequest: [selfService({ allowApiKey: true })],
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
        .select({
          mfaEnabled: users.mfaEnabled,
          mfaMethod: users.mfaMethod,
          email: users.email,
          phone: users.phone,
        })
        .from(users)
        .where(eq(users.id, userId));

      const mfaConfig = await getMfaConfig();
      const contact = { email: user?.email ?? null, phone: user?.phone ?? null };
      const availableMethods: string[] = [];
      if (mfaConfig.emailEnabled) availableMethods.push('email');
      if (mfaConfig.totpEnabled) availableMethods.push('totp');
      // SMS codes need a phone number on the profile.
      if (mfaConfig.smsEnabled && hasMfaContact('sms', contact)) availableMethods.push('sms');

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
      onRequest: [selfService()],
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
          400: errorWith('User not found or no phone for SMS codes', [
            ERROR_CODES.USER_NOT_FOUND,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          403: errorWith('MFA method disabled', [ERROR_CODES.MFA_METHOD_DISABLED]),
          409: errorResponse,
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
        .select({
          email: users.email,
          phone: users.phone,
          firstName: users.firstName,
          language: users.language,
          mfaEnabled: users.mfaEnabled,
        })
        .from(users)
        .where(eq(users.id, userId));
      if (user == null) {
        await reply.status(400).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      // Block re-setup when MFA is already enabled. Overwriting
      // `totpSecretEnc` here without a follow-up confirm would replace the
      // live secret the operator's authenticator app still trusts, locking
      // them out at next login. Force the password-gated disable flow
      // first. Mirrors the same guard on the portal driver endpoint.
      if (user.mfaEnabled) {
        await reply
          .status(409)
          .send({ error: 'MFA is already enabled', code: 'MFA_ALREADY_ENABLED' });
        return;
      }

      // A code sent to nothing would leave the user unable to confirm.
      if (!hasMfaContact(method, user)) {
        await reply.status(400).send({
          error: 'Add a phone number to your profile before you turn on SMS codes',
          code: 'VALIDATION_ERROR',
        });
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
        mfaCodeRecipient(method, user),
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
      onRequest: [selfService()],
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
          400: errorWith('Bad request', [
            ERROR_CODES.MFA_CODE_INVALID,
            ERROR_CODES.TOTP_NOT_CONFIGURED,
          ]),
          403: errorResponse,
          409: errorWith('MFA is already enabled', [ERROR_CODES.MFA_ALREADY_ENABLED]),
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

      const [user] = await db
        .select({ totpSecretEnc: users.totpSecretEnc, mfaEnabled: users.mfaEnabled })
        .from(users)
        .where(eq(users.id, userId));
      // Switching the method of an active MFA goes through the password-gated
      // disable and a new setup, like the setup step itself.
      if (user?.mfaEnabled === true) {
        await reply
          .status(409)
          .send({ error: 'MFA is already enabled', code: 'MFA_ALREADY_ENABLED' });
        return;
      }

      let verified = false;
      let totpStep: number | null = null;
      if (method === 'totp') {
        if (user?.totpSecretEnc == null) {
          await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
          return;
        }
        const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
        try {
          const secret = decryptString(user.totpSecretEnc, encKey);
          totpStep = matchTotpStep(secret, code);
          verified = totpStep != null;
        } catch (err: unknown) {
          // Stored TOTP secret cannot be decrypted (e.g. SETTINGS_ENCRYPTION_KEY
          // rotated, ciphertext corrupted). Surface as a clean MFA failure
          // rather than a 500, but log the underlying error for ops.
          request.log.warn({ err, userId }, 'TOTP secret decrypt failed');
          verified = false;
        }
      } else if (challengeId != null) {
        verified = (await verifyMfaChallenge(client, challengeId, code, { userId })) === 'verified';
      }

      if (!verified) {
        await reply
          .status(400)
          .send({ error: 'Invalid verification code', code: 'MFA_CODE_INVALID' });
        return;
      }

      // The confirming TOTP code cannot be replayed at the next sign-in.
      await db
        .update(users)
        .set({
          mfaEnabled: true,
          mfaMethod: method,
          totpLastStep: totpStep,
          mfaFailedCount: 0,
          mfaLockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      // End every other session (session version and refresh tokens) and
      // give this browser a new one; API keys stay.
      const sessionVersion = (await endUserSessions(userId, { apiKeys: false })) ?? 0;
      await issueOperatorSession(app, request, reply, {
        id: userId,
        roleId: (request.user as JwtPayload).roleId,
        sessionVersion,
      });

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
      onRequest: [selfService()],
      // Throttle so a stolen session cookie can't be used to brute-force the
      // password (each request hits argon2.verify with the supplied value).
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
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

      const valid = await verifyPassword(user.passwordHash, password, request.log);
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
          totpLastStep: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      // End every other session and give this browser a new one; API keys stay.
      const sessionVersion = (await endUserSessions(userId, { apiKeys: false })) ?? 0;
      await issueOperatorSession(app, request, reply, {
        id: userId,
        roleId: (request.user as JwtPayload).roleId,
        sessionVersion,
      });

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
      provider: z
        .string()
        .nullable()
        .describe('Selected AI provider (anthropic, openai, gemini, deepseek)'),
      apiKey: z
        .string()
        .nullable()
        .describe('Provider API key (decrypted from storage; null when unset)'),
      model: z.string().nullable().describe('Model override applied for this user'),
      effort: z
        .enum(AI_EFFORTS)
        .nullable()
        .describe('Reasoning effort (low, medium, high); null uses the default (medium)'),
      systemPrompt: z
        .string()
        .nullable()
        .describe('Custom system prompt that overrides the default'),
    })
    .passthrough();

  // --- Notification Preferences ---

  const operatorNotificationPrefsResponse = z
    .object({
      smsEnabled: z.boolean().describe('Whether the operator opted in to SMS notifications'),
      aiDigestEmail: z
        .boolean()
        .describe(
          'Whether the operator gets the daily email of AI insight actions waiting for a decision (default off)',
        ),
    })
    .passthrough();
  // Either field alone: the one not sent keeps its stored value.
  const operatorNotificationPrefsBody = z.object({
    smsEnabled: z.boolean().optional().describe('Opt in to SMS notifications'),
    aiDigestEmail: z
      .boolean()
      .optional()
      .describe('Opt in to the daily email of AI insight actions waiting for a decision'),
  });

  app.get(
    '/users/me/notification-preferences',
    {
      onRequest: [selfService({ allowApiKey: true })],
      schema: {
        tags: ['Users'],
        summary: 'Get operator notification preferences',
        operationId: 'getUserNotificationPreferences',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(operatorNotificationPrefsResponse) },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const [prefs] = await db
        .select()
        .from(userNotificationPreferences)
        .where(eq(userNotificationPreferences.userId, userId));
      return {
        smsEnabled: prefs?.smsEnabled ?? true,
        aiDigestEmail: prefs?.aiDigestEmail ?? false,
      };
    },
  );

  app.put(
    '/users/me/notification-preferences',
    {
      onRequest: [selfService()],
      schema: {
        tags: ['Users'],
        summary: 'Update operator notification preferences',
        operationId: 'updateUserNotificationPreferences',
        security: [{ bearerAuth: [] }],
        body: zodSchema(operatorNotificationPrefsBody),
        response: {
          200: itemResponse(operatorNotificationPrefsResponse),
          400: errorWith('No preference sent', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const body = request.body as z.infer<typeof operatorNotificationPrefsBody>;
      if (body.smsEnabled === undefined && body.aiDigestEmail === undefined) {
        return reply.status(400).send({
          error: 'Send smsEnabled, aiDigestEmail or both',
          code: ERROR_CODES.VALIDATION_ERROR,
        });
      }
      const changes = {
        ...(body.smsEnabled !== undefined ? { smsEnabled: body.smsEnabled } : {}),
        ...(body.aiDigestEmail !== undefined ? { aiDigestEmail: body.aiDigestEmail } : {}),
      };
      const [previous] = await db
        .select({
          smsEnabled: userNotificationPreferences.smsEnabled,
          aiDigestEmail: userNotificationPreferences.aiDigestEmail,
        })
        .from(userNotificationPreferences)
        .where(eq(userNotificationPreferences.userId, userId));
      const [prefs] = await db
        .insert(userNotificationPreferences)
        .values({ userId, ...changes })
        .onConflictDoUpdate({
          target: [userNotificationPreferences.userId],
          set: { ...changes, updatedAt: new Date() },
        })
        .returning();
      const result = {
        smsEnabled: prefs?.smsEnabled ?? true,
        aiDigestEmail: prefs?.aiDigestEmail ?? false,
      };
      const diff = changedFields(
        {
          smsEnabled: previous?.smsEnabled ?? true,
          aiDigestEmail: previous?.aiDigestEmail ?? false,
        },
        result,
      );
      if (Object.keys(diff.after).length > 0) {
        await writeAudit(
          { table: userAuditLog, idColumn: 'user_id' },
          {
            entityId: userId,
            entityIdSnapshot: userId,
            action: 'updated',
            ...getAuditActor(request),
            before: diff.before,
            after: diff.after,
            notes: 'notification preferences',
          },
          db,
          request.log,
        );
      }
      return result;
    },
  );

  app.get(
    '/users/me/chatbot-ai-config',
    {
      onRequest: [selfService()],
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
          apiKeyEnc: chatbotAiConfigs.apiKeyEnc,
          model: chatbotAiConfigs.model,
          effort: chatbotAiConfigs.effort,
          systemPrompt: chatbotAiConfigs.systemPrompt,
        })
        .from(chatbotAiConfigs)
        .where(eq(chatbotAiConfigs.userId, userId));

      // A row exists with empty chatbot fields when the user deleted their
      // chatbot config but kept a support-ai config in the same row. Treat
      // that as "not configured" so the UI doesn't show empty fields.
      if (row == null || row.apiKeyEnc === '' || row.provider === '') {
        return {
          configured: false,
          provider: null,
          apiKey: null,
          model: null,
          effort: null,
          systemPrompt: null,
        };
      }

      const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
      let apiKey: string | null = null;
      if (encKey !== '') {
        apiKey = decryptString(row.apiKeyEnc, encKey);
      }

      return {
        configured: true,
        provider: row.provider,
        apiKey,
        model: row.model ?? null,
        effort: isAiEffort(row.effort) ? row.effort : null,
        systemPrompt: row.systemPrompt ?? null,
      };
    },
  );

  const aiConfigBody = z.object({
    provider: z.enum(AI_PROVIDER_IDS).describe('AI provider'),
    apiKey: z.string().min(1).describe('Provider API key'),
    model: z.string().optional().describe('Model override (leave empty for provider default)'),
    effort: z
      .enum(AI_EFFORTS)
      .optional()
      .describe('Reasoning effort (low, medium, high); omit for the default (medium)'),
    systemPrompt: z.string().max(8000).optional().describe('Custom system prompt (max 8000 chars)'),
  });

  app.put(
    '/users/me/chatbot-ai-config',
    {
      onRequest: [selfService()],
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
      const { provider, apiKey, model, effort, systemPrompt } = request.body as z.infer<
        typeof aiConfigBody
      >;

      const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
      if (encKey === '') {
        throw new Error('SETTINGS_ENCRYPTION_KEY is required to store AI API keys');
      }
      const apiKeyEnc = encryptString(apiKey, encKey);
      const previous = await readAiConfigState(userId, 'chatbot');

      await db
        .insert(chatbotAiConfigs)
        .values({
          userId,
          provider,
          apiKeyEnc,
          model: model ?? null,
          effort: effort ?? null,
          systemPrompt: personalSystemPrompt('chatbot', systemPrompt),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: chatbotAiConfigs.userId,
          set: {
            provider,
            apiKeyEnc,
            model: model ?? null,
            effort: effort ?? null,
            systemPrompt: personalSystemPrompt('chatbot', systemPrompt),
            updatedAt: new Date(),
          },
        });

      await writeAiConfigAudit(request, userId, 'chatbot', previous, {
        fields: {
          provider,
          model: model ?? null,
          effort: effort ?? null,
          systemPrompt: personalSystemPrompt('chatbot', systemPrompt),
        },
        keyReplaced: previous != null && aiKeyReplaced(previous.apiKeyEnc, apiKey, encKey),
      });
      return { success: true };
    },
  );

  app.delete(
    '/users/me/chatbot-ai-config',
    {
      onRequest: [selfService()],
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

      // Mirror the support-ai DELETE: clear only the chatbot columns if a
      // support AI config exists, else drop the whole row. A blind delete
      // here would also wipe the operator's support AI config, which lives
      // in the same row.
      const [row] = await db
        .select({ supportAiApiKeyEnc: chatbotAiConfigs.supportAiApiKeyEnc })
        .from(chatbotAiConfigs)
        .where(eq(chatbotAiConfigs.userId, userId));

      if (row == null) {
        return { success: true };
      }
      const previous = await readAiConfigState(userId, 'chatbot');

      if (row.supportAiApiKeyEnc == null || row.supportAiApiKeyEnc === '') {
        await db.delete(chatbotAiConfigs).where(eq(chatbotAiConfigs.userId, userId));
      } else {
        // The schema's chatbot columns (provider, apiKeyEnc) are NOT NULL,
        // so we can't null them out while keeping the support AI columns.
        // Use empty strings as the cleared marker; resolveConfig checks
        // truthiness and falls through to system settings when blank.
        await db
          .update(chatbotAiConfigs)
          .set({
            provider: '',
            apiKeyEnc: '',
            model: null,
            effort: null,
            systemPrompt: null,
            updatedAt: new Date(),
          })
          .where(eq(chatbotAiConfigs.userId, userId));
      }

      await writeAiConfigAudit(request, userId, 'chatbot', previous, null);
      return { success: true };
    },
  );

  // --- Support AI Config endpoints ---

  const supportAiConfigResponse = z
    .object({
      configured: z.boolean().describe('Whether the user has saved a personal support AI config'),
      provider: z.string().nullable().describe('Selected AI provider for support case drafting'),
      apiKey: z
        .string()
        .nullable()
        .describe('Provider API key (decrypted from storage; null when unset)'),
      model: z.string().nullable().describe('Model override applied for this user'),
      effort: z
        .enum(AI_EFFORTS)
        .nullable()
        .describe('Reasoning effort (low, medium, high); null uses the default (medium)'),
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
      onRequest: [selfService()],
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
          supportAiApiKeyEnc: chatbotAiConfigs.supportAiApiKeyEnc,
          supportAiModel: chatbotAiConfigs.supportAiModel,
          supportAiEffort: chatbotAiConfigs.supportAiEffort,
          supportAiSystemPrompt: chatbotAiConfigs.supportAiSystemPrompt,
          supportAiTone: chatbotAiConfigs.supportAiTone,
        })
        .from(chatbotAiConfigs)
        .where(eq(chatbotAiConfigs.userId, userId));

      if (row == null || row.supportAiProvider == null) {
        return {
          configured: false,
          provider: null,
          apiKey: null,
          model: null,
          effort: null,
          systemPrompt: null,
          tone: null,
        };
      }

      const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
      let apiKey: string | null = null;
      if (row.supportAiApiKeyEnc != null && row.supportAiApiKeyEnc !== '' && encKey !== '') {
        apiKey = decryptString(row.supportAiApiKeyEnc, encKey);
      }

      return {
        configured: true,
        provider: row.supportAiProvider,
        apiKey,
        model: row.supportAiModel ?? null,
        effort: isAiEffort(row.supportAiEffort) ? row.supportAiEffort : null,
        systemPrompt: row.supportAiSystemPrompt ?? null,
        tone: row.supportAiTone ?? null,
      };
    },
  );

  const supportAiConfigBody = z.object({
    provider: z.enum(AI_PROVIDER_IDS).describe('AI provider for support case assistance'),
    apiKey: z.string().min(1).describe('Provider API key'),
    model: z.string().optional().describe('Model override (leave empty for provider default)'),
    effort: z
      .enum(AI_EFFORTS)
      .optional()
      .describe('Reasoning effort (low, medium, high); omit for the default (medium)'),
    systemPrompt: z
      .string()
      .max(8000)
      .optional()
      .describe('Custom system prompt for support AI (max 8000 chars)'),
    tone: z
      .enum(['professional', 'friendly', 'formal'])
      .optional()
      .describe('Response tone — one of professional, friendly, formal'),
  });

  app.put(
    '/users/me/support-ai-config',
    {
      onRequest: [selfService()],
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
      const { provider, apiKey, model, effort, systemPrompt, tone } = request.body as z.infer<
        typeof supportAiConfigBody
      >;

      const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
      if (encKey === '') {
        throw new Error('SETTINGS_ENCRYPTION_KEY is required to store AI API keys');
      }
      const supportAiApiKeyEnc = encryptString(apiKey, encKey);

      const supportAiFields = {
        supportAiProvider: provider,
        supportAiApiKeyEnc,
        supportAiModel: model ?? null,
        supportAiEffort: effort ?? null,
        supportAiSystemPrompt: personalSystemPrompt('support', systemPrompt),
        supportAiTone: tone ?? null,
        updatedAt: new Date(),
      };

      // Check if a row exists for this user
      const previous = await readAiConfigState(userId, 'support');
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

      await writeAiConfigAudit(request, userId, 'support', previous, {
        fields: {
          provider,
          model: model ?? null,
          effort: effort ?? null,
          systemPrompt: personalSystemPrompt('support', systemPrompt),
          tone: tone ?? null,
        },
        keyReplaced: previous != null && aiKeyReplaced(previous.apiKeyEnc, apiKey, encKey),
      });
      return { success: true };
    },
  );

  app.delete(
    '/users/me/support-ai-config',
    {
      onRequest: [selfService()],
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
      const previous = await readAiConfigState(userId, 'support');

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
            supportAiEffort: null,
            supportAiSystemPrompt: null,
            supportAiTone: null,
            updatedAt: new Date(),
          })
          .where(eq(chatbotAiConfigs.userId, userId));
      }

      await writeAiConfigAudit(request, userId, 'support', previous, null);
      return { success: true };
    },
  );

  // ------ Permission endpoints ------

  const permissionGroupItem = z
    .object({
      resource: z
        .string()
        .describe('Resource of the group, the part before the colon, e.g. stations'),
      kind: z
        .enum(['page', 'settings'])
        .describe('page for a CSMS page, settings for a Settings tab'),
      labelKey: z.string().describe('CSMS locale key of the group label'),
      permissions: z
        .array(z.string())
        .describe('The read and write permission strings of the resource'),
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
      return permissionCatalog.groups();
    },
  );

  app.get(
    '/users/me/permissions',
    {
      onRequest: [selfService({ allowApiKey: true })],
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

      if (user == null || !(await canManageUser(await getUserManagementActor(request), id))) {
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
          403: errorWith('Forbidden', [
            ERROR_CODES.FORBIDDEN,
            ERROR_CODES.SELF_EDIT_FORBIDDEN,
            ERROR_CODES.PERMISSIONS_EXCEED_OWN,
          ]),
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

      const actor = await getUserManagementActor(request);
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));

      // The target's current permissions must be within the actor's own too:
      // no one rewrites (or strips) the permissions of a more privileged user.
      if (user == null || !(await canAdministerUser(request, actor, id))) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      // Validate all permissions are in the catalog
      const invalid = permissions.filter((p) => !permissionCatalog.isKnown(p));
      if (invalid.length > 0) {
        await reply.status(400).send({
          error: `Invalid permissions: ${invalid.join(', ')}`,
          code: 'INVALID_PERMISSIONS',
        });
        return;
      }

      // An operator grants only permissions it holds.
      if (!(await canGrantPermissions(request, permissions))) {
        await reply.status(403).send({
          error: 'Permissions must be a subset of your own permissions',
          code: 'PERMISSIONS_EXCEED_OWN',
        });
        return;
      }

      // One transaction: the before snapshot, the replacement and the
      // session version (access tokens of the old permissions end) commit
      // together or not at all.
      const beforePermRows = await db.transaction(async (tx) => {
        const before = await tx
          .select({ permission: userPermissions.permission })
          .from(userPermissions)
          .where(eq(userPermissions.userId, id));
        await tx.delete(userPermissions).where(eq(userPermissions.userId, id));
        if (permissions.length > 0) {
          await tx
            .insert(userPermissions)
            .values(permissions.map((p) => ({ userId: id, permission: p })))
            .onConflictDoNothing();
        }
        await bumpSessionVersion(id, tx);
        return before;
      });
      invalidatePermissionCache(id);
      announceSessionChange(id);

      const auditActor = getAuditActor(request);
      await writeAudit(
        { table: userAuditLog, idColumn: 'user_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'permissions_changed',
          ...auditActor,
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
