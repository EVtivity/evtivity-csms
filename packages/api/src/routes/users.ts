// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { JwtPayload } from '../plugins/auth.js';
import crypto from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { eq, and, or, isNull, ilike, sql, inArray, desc, ne } from 'drizzle-orm';
import argon2 from 'argon2';
import {
  db,
  client,
  getMfaConfig,
  readMfaConfig,
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
import { accountAuditActor, getAuditActor } from '../lib/audit-actor.js';
import { factorFlags, sendSecurityNotice } from '../lib/security-notice.js';
import {
  consumeRecoveryCode,
  countRecoveryCodes,
  countWebauthnCredentials,
  recoveryCodesUsedUp,
  deleteRecoveryCodes,
  deleteWebauthnCredentials,
  issueRecoveryCodes,
  mfaFactorCounts,
} from '../services/mfa-factor.service.js';
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
  isMfaChallengeLimited,
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
  sessionRefreshTokenUserId,
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
import { checkCurrentPassword } from '../lib/current-password.js';
import {
  clearSignInFailures,
  acceptTotpStep,
  createAccountMfaChallenge,
  sendMfaResendLimited,
  recordAttemptFailure,
  secondsUntil,
  takeSignInAttempt,
} from '../lib/sign-in-backoff.js';
import { applyUserDeactivation, revokeUserEmailLinks } from '../services/user-status.service.js';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { emailEquals } from '../lib/email-match.js';
import { verifyAgainstDummyHash } from '../lib/dummy-password-hash.js';
import {
  hasMfaContact,
  mfaCodeDestination,
  mfaCodeRecipient,
  removesSmsMfaPhone,
} from '../lib/mfa-contact.js';
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
import { verifyRecoveryCodesPasskey } from '../lib/webauthn-http.js';
import {
  FACTOR_PROOF_KINDS,
  ssoProofUntil,
  authenticationCredential,
  checkFactorProof,
  factorProof,
  factorProofKindsOf,
  lastFactorProofKindsOf,
  proofAccountOf,
  sendFactorProofRefusal,
} from '../lib/mfa-factor-proof.js';
import { loginResponse } from '../lib/login-response.js';
import {
  PHONE_CHANGE_METHOD,
  checkPhoneChange,
  INVALID_PHONE_REPLY,
  normalizedPhone,
  phoneToStore,
  phoneVerification,
  phoneVerificationRefusal,
  readPhoneInput,
} from '../lib/phone-change.js';
import {
  availableMfaMethods,
  isMfaEnrollmentRequest,
  isMfaPolicyUnavailable,
  isMfaSetupUnavailable,
  mfaPolicyForRole,
  operatorMfaEnrollment,
  renewalMfaGate,
  selfServiceOrMfaEnrollment,
  sendMfaPolicyUnavailable,
  mfaPendingTokenCurrent,
  sendMfaTokenExpired,
} from '../lib/mfa-enrollment.js';
import { hasMfa, mfaMethodGate, passkeyGate, usableFactors } from '../lib/mfa-factors.js';
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
import {
  newPasswordSchema,
  validatePassword,
  weakPasswordFields,
} from '../lib/password-validation.js';
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
  phone: z
    .string()
    .max(50)
    .nullable()
    .optional()
    .describe(
      'Mobile phone number. For an account with a factor a change needs proof; with SMS codes as the sign-in method it needs phoneVerification instead',
    ),
  proof: factorProof
    .optional()
    .describe(
      'A phone change of an account with a factor: fresh proof of the account (a factor it holds, as to add one)',
    ),
  phoneVerification: phoneVerification.optional(),
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
  password: newPasswordSchema,
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: newPasswordSchema,
});

const forgotPasswordBody = z.object({
  email: z.string().email(),
  recaptchaToken: z.string().optional().describe('reCAPTCHA v3 token'),
});

const resetPasswordWithTokenBody = z.object({
  token: z.string().min(1).describe('Password reset token from email link'),
  password: newPasswordSchema,
});

const forceChangePasswordBody = z.object({
  email: z.string().email(),
  currentPassword: z.string().min(1),
  newPassword: newPasswordSchema,
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
          403: errorWith('Forbidden', [
            ERROR_CODES.ACCOUNT_DISABLED,
            ERROR_CODES.RECAPTCHA_FAILED,
            ERROR_CODES.MFA_SETUP_UNAVAILABLE,
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
      // enabled answer as for a wrong password, after the same time. The try is
      // counted in the UPDATE that checks the lock, so parallel guesses cannot pass it.
      const ssoBlocked = await passwordAuthBlocked(user);
      const attempt = ssoBlocked ? null : await takeSignInAttempt({ userId: user.id }, 'password');
      const locked = attempt?.granted === false;
      if (attempt == null || !attempt.granted) {
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
        await recordAttemptFailure(request, attempt);
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }
      await clearSignInFailures({ userId: user.id }, 'password');

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
      if (mfaPending != null && isMfaSetupUnavailable(mfaPending)) {
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'password',
          reason: 'mfa_setup_unavailable',
        });
        await reply.status(403).send({
          error: 'Required MFA cannot be set up: no MFA method is available',
          code: 'MFA_SETUP_UNAVAILABLE',
        });
        return;
      }
      if (mfaPending != null && isMfaPolicyUnavailable(mfaPending)) {
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'password',
          reason: 'mfa_policy_unavailable',
        });
        await sendMfaPolicyUnavailable(request, reply, user.id);
        return;
      }
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
        description:
          'Rotates the refresh token and issues new session cookies. While required MFA (Settings > Security > MFA) covers the user and the account has no usable factor (MFA method, recovery code or passkey), the refresh token is revoked and the answer is 401 MFA_ENROLLMENT_REQUIRED with no new session: signing in again leads to the MFA setup. When the MFA settings cannot be read, a user without a factor gets 503 MFA_POLICY_UNAVAILABLE and the refresh token is kept.',
        operationId: 'refreshToken',
        security: [],
        response: {
          200: successResponse,
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
      const refreshCookie = readRefreshCookie('csms', request);
      if (refreshCookie.status === 'absent') {
        await reply.status(401).send({ error: 'No refresh token', code: 'NO_REFRESH_TOKEN' });
        return;
      }

      // Required MFA reaches signed-in users here, before the token rotates, so a
      // settings read failure keeps the refresh token for the next try.
      if (refreshCookie.status === 'valid') {
        const holderId = await sessionRefreshTokenUserId(refreshCookie.value);
        const [holder] =
          holderId == null
            ? []
            : await db
                .select({
                  id: users.id,
                  roleId: users.roleId,
                  isActive: users.isActive,
                  mfaEnabled: users.mfaEnabled,
                  mfaMethod: users.mfaMethod,
                })
                .from(users)
                .where(eq(users.id, holderId));
        if (holder?.isActive === true) {
          const gate = await renewalMfaGate(holder);
          if (gate === 'policy_unavailable') {
            await sendMfaPolicyUnavailable(request, reply, holder.id);
            return;
          }
          if (gate === 'enrollment_required') {
            await revokeRefreshToken(refreshCookie.value);
            clearAuthCookies('csms', reply, isSecureRequest(request));
            request.log.info(
              { userId: holder.id },
              'Required MFA covers the user and no factor is set up, the session is not renewed',
            );
            await reply
              .status(401)
              .send({ error: 'Set up MFA to continue', code: 'MFA_ENROLLMENT_REQUIRED' });
            return;
          }
        }
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
          400: errorWith('Weak password', [ERROR_CODES.WEAK_PASSWORD], weakPasswordFields),
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

      const weakPassword = await validatePassword(password);
      if (weakPassword != null) {
        await reply.status(400).send(weakPassword);
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
          400: errorWith('Weak password', [ERROR_CODES.WEAK_PASSWORD], weakPasswordFields),
          401: errorWith('Invalid credentials', [ERROR_CODES.INVALID_CREDENTIALS]),
          403: errorWith('Required MFA cannot be set up', [ERROR_CODES.MFA_SETUP_UNAVAILABLE]),
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
      const { email, currentPassword, newPassword } = request.body as z.infer<
        typeof forceChangePasswordBody
      >;

      const [user] = await db.select().from(users).where(emailEquals(users.email, email));

      // The password is checked first (against a dummy hash for an unknown
      // email), and every refusal answers the same 401, so the route tells
      // nothing about the account: not whether it exists, is active, needs
      // a reset, is locked or signs in with SSO.
      // The try is counted in the UPDATE that checks the lock, so parallel guesses cannot pass it.
      const attempt =
        user != null ? await takeSignInAttempt({ userId: user.id }, 'password') : null;
      const locked = attempt?.granted === false;
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
          if (refusal === 'bad_password' && attempt?.granted === true) {
            await recordAttemptFailure(request, attempt);
          } else if (valid && !locked) {
            await clearSignInFailures({ userId: user.id }, 'password');
          }
        }
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }
      await clearSignInFailures({ userId: user.id }, 'password');

      const weakPassword = await validatePassword(newPassword);
      if (weakPassword != null) {
        await reply.status(400).send(weakPassword);
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
      // The new session version: the enrollment JWT must outlive the sessions just ended.
      const mfaPending = await beginOperatorMfa(app, { ...user, sessionVersion });
      if (mfaPending != null && isMfaSetupUnavailable(mfaPending)) {
        // The password change stands; only the session is refused.
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'password',
          reason: 'mfa_setup_unavailable',
        });
        await reply.status(403).send({
          error: 'Required MFA cannot be set up: no MFA method is available',
          code: 'MFA_SETUP_UNAVAILABLE',
        });
        return;
      }
      if (mfaPending != null && isMfaPolicyUnavailable(mfaPending)) {
        // The password change stands; only the session is refused.
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'password',
          reason: 'mfa_policy_unavailable',
        });
        await sendMfaPolicyUnavailable(request, reply, user.id);
        return;
      }
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
          'Self-service update of safe profile fields (name, phone, language, timezone, theme). Auth-only, not RBAC-gated, so non-admin operators can save their own Profile page without holding the users:write permission. Sensitive fields (roleId, isActive, hasAllSiteAccess, siteIds) are intentionally not part of this body; admins use PATCH /v1/users/:id for those. A phone change of an account with a second factor needs proof (a factor it holds; 400 VALIDATION_ERROR with proofKinds otherwise); an account that signs in with SMS codes instead confirms the new number with phoneVerification, the code POST /v1/users/me/phone-verification sent to it.',
        operationId: 'updateCurrentUser',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateMeBody),
        response: {
          200: itemResponse(userWithRole),
          400: errorWith(
            'Invalid timezone, the phone of an SMS second factor cannot be removed, or a phone change lacks its proof or verification',
            [
              ERROR_CODES.VALIDATION_ERROR,
              ERROR_CODES.MFA_CODE_INVALID,
              ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
              ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
              ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
            ],
            {
              proofKinds: z
                .array(z.enum(FACTOR_PROOF_KINDS))
                .optional()
                .describe('A missing or wrong proof: the proof kinds the account accepts'),
              phoneVerificationRequired: z
                .boolean()
                .optional()
                .describe('An SMS sign-in account must confirm the new number with its code'),
            },
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

      // Stored, compared and texted in E.164 only.
      const phoneIn = readPhoneInput(body.phone);
      if (phoneIn.kind === 'invalid') {
        await reply.status(400).send(INVALID_PHONE_REPLY);
        return;
      }
      const nextPhone = phoneToStore(phoneIn);

      if (nextPhone !== undefined && (await smsMfaNeedsPhone(userId, nextPhone))) {
        await reply.status(400).send(SMS_MFA_PHONE_REQUIRED);
        return;
      }

      // SMS codes go to this number: a stolen session must not be able to move them.
      if (nextPhone !== undefined) {
        const [current] = await db
          .select({ phone: users.phone })
          .from(users)
          .where(eq(users.id, userId));
        const refused = await checkPhoneChange(
          request,
          { userId },
          {
            current: normalizedPhone(current?.phone),
            next: nextPhone,
            proof: body.proof,
            verification: body.phoneVerification,
          },
        );
        if (refused != null) {
          await reply.status(refused.status).send(refused.body);
          return;
        }
      }

      const fields: Record<string, unknown> = { updatedAt: new Date() };
      if (body.firstName !== undefined) fields['firstName'] = body.firstName;
      if (body.lastName !== undefined) fields['lastName'] = body.lastName;
      if (nextPhone !== undefined) fields['phone'] = nextPhone;
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

      // Tell the user, and text the previous number when SMS codes went there.
      if (
        nextPhone !== undefined &&
        normalizedPhone(before?.phone) !== normalizedPhone(updated.phone)
      ) {
        sendSecurityNotice(
          { userId },
          'security.PhoneChanged',
          { byAdmin: false, phoneRemoved: updated.phone == null },
          request.log,
          {
            phone: before?.mfaEnabled === true && before.mfaMethod === 'sms' ? before.phone : null,
          },
        );
      }

      const [role] = updated.roleId
        ? await db
            .select({ id: roles.id, name: roles.name })
            .from(roles)
            .where(eq(roles.id, updated.roleId))
        : [];

      return { ...updated, role: role ?? null };
    },
  );

  const phoneVerificationStartBody = z.object({
    phone: z.string().min(1).max(50).describe('The new mobile phone number'),
    proof: factorProof
      .optional()
      .describe(
        'Fresh proof of the account: a factor it holds, else its password, else a fresh SSO sign-in; an account with none of them is refused',
      ),
  });

  app.post(
    '/users/me/phone-verification',
    {
      onRequest: [selfService()],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Users'],
        summary: 'Send a code to confirm a new phone number',
        description:
          'For an account that signs in with SMS codes (any other account, or the current number, answers 400 VALIDATION_ERROR): after the fresh proof of the account, texts a code to the new number and returns its challengeId. Send it as phoneVerification with the phone on PATCH /v1/users/me. The code is bound to that number and works once, for 5 minutes; at most 5 codes in 15 minutes per account and 3 an hour per number across accounts (429 MFA_RESEND_LIMITED).',
        operationId: 'startPhoneVerification',
        security: [{ bearerAuth: [] }],
        body: zodSchema(phoneVerificationStartBody),
        response: {
          200: itemResponse(
            z
              .object({ challengeId: z.number().int().describe('Send it back with the code') })
              .passthrough(),
          ),
          400: errorWith(
            'No number, or the proof is missing or wrong',
            [
              ERROR_CODES.VALIDATION_ERROR,
              ERROR_CODES.INVALID_PASSWORD,
              ERROR_CODES.MFA_CODE_INVALID,
              ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
              ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
              ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
            ],
            {
              proofKinds: z
                .array(z.enum(FACTOR_PROOF_KINDS))
                .optional()
                .describe('A missing or wrong proof: the proof kinds the account accepts'),
            },
          ),
          403: errorWith('API keys cannot change the profile', [ERROR_CODES.SESSION_REQUIRED]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
          429: errorWith('Too many codes sent', [ERROR_CODES.MFA_RESEND_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const body = request.body as z.infer<typeof phoneVerificationStartBody>;
      const phoneIn = readPhoneInput(body.phone);
      if (phoneIn.kind !== 'number') {
        await reply.status(400).send(INVALID_PHONE_REPLY);
        return;
      }
      const { phone } = phoneIn;
      const [user] = await db
        .select({
          firstName: users.firstName,
          language: users.language,
          phone: users.phone,
          mfaEnabled: users.mfaEnabled,
          mfaMethod: users.mfaMethod,
        })
        .from(users)
        .where(eq(users.id, userId));
      if (user == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }
      // Checked before the proof, so a refused request spends none.
      const notSent = phoneVerificationRefusal(user, phone);
      if (notSent != null) {
        await reply.status(400).send({ error: notSent, code: 'VALIDATION_ERROR' });
        return;
      }
      const refused = await checkFactorProof(request, { userId }, body.proof);
      if (refused != null) {
        await sendFactorProofRefusal(reply, refused);
        return;
      }
      const challenge = await createAccountMfaChallenge({ userId }, PHONE_CHANGE_METHOD, {
        purpose: 'setup',
        destination: phone,
      });
      if (isMfaChallengeLimited(challenge)) {
        await sendMfaResendLimited(reply, challenge.retryAfterSeconds);
        return;
      }
      await dispatchSystemNotification(
        client,
        'mfa.VerificationCode',
        {
          phone,
          language: user.language,
          ...(user.firstName != null ? { firstName: user.firstName } : {}),
        },
        { code: challenge.code },
        TEMPLATES_DIR,
      );
      return { challengeId: challenge.challengeId };
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

      const createPhoneIn = readPhoneInput(body.phone);
      if (createPhoneIn.kind === 'invalid') {
        await reply.status(400).send(INVALID_PHONE_REPLY);
        return;
      }
      const createPhone = phoneToStore(createPhoneIn);

      // Generate unknown random password — user must set via email link
      const passwordHash = await argon2.hash(crypto.randomBytes(32).toString('hex'));

      const rows = await db
        .insert(users)
        .values({
          email: body.email,
          passwordHash,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: createPhone,
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
        // The own phone and email change only through PATCH /v1/users/me, which asks for
        // the fresh proof: SMS and email codes go there.
        if (body.phone !== undefined || body.email !== undefined) {
          await reply.status(403).send({
            error: 'Change your own phone or email in your profile (PATCH /v1/users/me)',
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
      const adminPhoneIn = readPhoneInput(body.phone);
      if (adminPhoneIn.kind === 'invalid') {
        await reply.status(400).send(INVALID_PHONE_REPLY);
        return;
      }
      const adminPhone = phoneToStore(adminPhoneIn);
      if (adminPhone !== undefined && (await smsMfaNeedsPhone(id, adminPhone))) {
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
      if (adminPhone !== undefined) fields['phone'] = adminPhone;
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

      // An admin changed the address or number the user's sign-in links and codes go
      // to: tell the user at the previous one.
      if (emailChanged) {
        sendSecurityNotice({ userId: id }, 'security.EmailChanged', {}, request.log, {
          email: before.email,
        });
      }
      if (
        adminPhone !== undefined &&
        normalizedPhone(before.phone) !== normalizedPhone(adminPhone)
      ) {
        sendSecurityNotice(
          { userId: id },
          'security.PhoneChanged',
          { byAdmin: true, phoneRemoved: adminPhone == null },
          request.log,
          { phone: before.phone },
        );
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
          400: errorWith('Weak password', [ERROR_CODES.WEAK_PASSWORD], weakPasswordFields),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
          409: errorWith('The user signs in with SSO', [ERROR_CODES.USER_SSO_MANAGED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof userParams>;
      const { password } = request.body as z.infer<typeof resetPasswordBody>;

      const weakPassword = await validatePassword(password);
      if (weakPassword != null) {
        await reply.status(400).send(weakPassword);
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
          400: errorWith(
            'Weak password',
            [ERROR_CODES.WEAK_PASSWORD, ERROR_CODES.INVALID_PASSWORD],
            weakPasswordFields,
          ),
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
          loginLockedUntil: users.loginLockedUntil,
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
        !(await passwordAuthBlocked(user)) &&
        (await checkCurrentPassword(request, { userId }, user, currentPassword));
      if (!valid) {
        await reply
          .status(400)
          .send({ error: 'Current password is incorrect', code: 'INVALID_PASSWORD' });
        return;
      }

      const weakPassword = await validatePassword(newPassword);
      if (weakPassword != null) {
        await reply.status(400).send(weakPassword);
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
          'Validates the short-lived MFA pending JWT, verifies the supplied TOTP code or email/SMS challenge code (single-use, 5-minute TTL) or a single-use recovery code, and on success issues the real access JWT plus refresh token cookies. A recovery code works even when the method is switched off, uses the code up and returns recoveryCodesRemaining. A wrong code or recovery code counts toward the per-account backoff.',
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
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          401: errorWith('Unauthorized', [ERROR_CODES.UNAUTHORIZED, ERROR_CODES.MFA_TOKEN_EXPIRED]),
          403: errorWith('Forbidden', [
            ERROR_CODES.ACCOUNT_DISABLED,
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

      let payload: { userId?: unknown; roleId: string; mfaPending?: boolean };
      try {
        payload = app.jwt.verify(mfaToken);
      } catch (err) {
        request.log.debug({ err }, 'MFA token did not verify, refusing it');
        await reply
          .status(401)
          .send({ error: 'Invalid or expired MFA token', code: 'MFA_TOKEN_EXPIRED' });
        return;
      }

      // A driver's MFA-pending token shares the signing key: it carries no userId.
      if (payload.mfaPending !== true || typeof payload.userId !== 'string') {
        await reply.status(400).send({ error: 'Invalid MFA token', code: 'MFA_TOKEN_INVALID' });
        return;
      }

      const [user] = await db.select().from(users).where(eq(users.id, payload.userId));
      if (user != null && !mfaPendingTokenCurrent(payload, user.sessionVersion)) {
        await sendMfaTokenExpired(reply);
        return;
      }
      const factorCounts =
        user != null
          ? await mfaFactorCounts({ userId: user.id })
          : { recoveryCodesRemaining: 0, passkeyCount: 0 };
      // A code needs a primary method; a recovery code also serves a passkey-only account.
      const primaryMethod = user?.mfaEnabled === true ? user.mfaMethod : null;
      if (
        user == null ||
        !hasMfa({ ...user, ...factorCounts }) ||
        (code != null && primaryMethod == null)
      ) {
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

      const mfaReading = await readMfaConfig();
      const recoveryCodesBefore = factorCounts.recoveryCodesRemaining;
      const gate = mfaMethodGate({ ...user, ...factorCounts }, mfaReading);
      // A recovery code has no method switch: it works whatever the gate says.
      if (recoveryCode == null && gate === 'refused') {
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'mfa',
          reason: 'mfa_method_disabled',
        });
        await reply
          .status(403)
          .send({ error: 'MFA method is disabled', code: 'MFA_METHOD_DISABLED' });
        return;
      }

      if (recoveryCode == null && user.mfaMethod === 'totp' && user.totpSecretEnc == null) {
        await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
        return;
      }

      // Per-account backoff after repeated wrong codes: the try is counted before the
      // check, in the UPDATE that checks the lock, so parallel guesses cannot pass it.
      const attempt = await takeSignInAttempt({ userId: user.id }, 'mfa');
      if (!attempt.granted) {
        const retryAfterSeconds = secondsUntil(attempt.lockedUntil ?? new Date());
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
      let recoveryCodesRemaining: number | undefined;
      if (recoveryCode != null) {
        const result = await consumeRecoveryCode({ userId: user.id }, recoveryCode, {
          actor: accountAuditActor({ userId: user.id }),
          log: request.log,
        });
        verified = result.used;
        if (result.used) recoveryCodesRemaining = result.remaining;
      } else if (code == null) {
        verified = false;
      } else if (user.mfaMethod === 'totp' && user.totpSecretEnc != null) {
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
        if (step != null) verified = await acceptTotpStep({ userId: user.id }, step);
      } else if (challengeId != null) {
        // Tries are counted on the challenge row (MFA_CHALLENGE_MAX_ATTEMPTS),
        // shared by every API process, and the challenge is single use.
        const result = await verifyMfaChallenge(client, challengeId, code, {
          userId: user.id,
          method: user.mfaMethod ?? '',
          purpose: 'sign_in',
          destination: mfaCodeDestination(user.mfaMethod, user),
        });
        verified = result === 'verified';
        exhausted = result === 'exhausted';
      }

      if (!verified) {
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
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
      await clearSignInFailures({ userId: user.id }, 'mfa');

      const [role] = await db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(eq(roles.id, user.roleId));

      // A switched-off method that was the only factor, or the last recovery code of such
      // an account, leaves no factor: the user proved the old one and now sets up another.
      const factorsAfter = {
        ...user,
        ...factorCounts,
        recoveryCodesRemaining: recoveryCodesRemaining ?? recoveryCodesBefore,
      };
      const enrollmentRequired =
        usableFactors(factorsAfter, mfaReading).length === 0 &&
        (mfaMethodGate(factorsAfter, mfaReading) === 'enrollment_required' ||
          passkeyGate(factorsAfter, mfaReading) === 'enrollment_required');
      const enrollment = enrollmentRequired
        ? operatorMfaEnrollment(app, user, mfaReading.config)
        : null;
      if (enrollment != null) {
        return {
          ...enrollment,
          ...(recoveryCodesRemaining != null ? { recoveryCodesRemaining } : {}),
        };
      }

      const token = await issueOperatorSession(app, request, reply, user);
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      await recordAuthAudit(request, {
        kind: 'user',
        accountId: user.id,
        action: 'login_succeeded',
        method: recoveryCode != null ? 'recovery_code' : 'mfa',
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
        ...(recoveryCodesRemaining != null ? { recoveryCodesRemaining } : {}),
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

      let payload: { userId?: unknown; roleId: string; mfaPending?: boolean };
      try {
        payload = app.jwt.verify(mfaToken);
      } catch (err) {
        request.log.debug({ err }, 'MFA token did not verify, refusing it');
        await reply
          .status(401)
          .send({ error: 'Invalid or expired MFA token', code: 'MFA_TOKEN_EXPIRED' });
        return;
      }

      // A driver's MFA-pending token shares the signing key: it carries no userId.
      if (payload.mfaPending !== true || typeof payload.userId !== 'string') {
        await reply.status(400).send({ error: 'Invalid MFA token', code: 'MFA_TOKEN_INVALID' });
        return;
      }

      const [user] = await db.select().from(users).where(eq(users.id, payload.userId));
      if (user != null && !mfaPendingTokenCurrent(payload, user.sessionVersion)) {
        await sendMfaTokenExpired(reply);
        return;
      }
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

      if (
        mfaMethodGate(
          { ...user, ...(await mfaFactorCounts({ userId: user.id })) },
          await readMfaConfig(),
        ) === 'refused'
      ) {
        await reply
          .status(403)
          .send({ error: 'MFA method is disabled', code: 'MFA_METHOD_DISABLED' });
        return;
      }

      // A cap on the codes sent to one user, counted from the challenge rows
      // under a per-account lock so every process sees the same count.
      const challenge = await createAccountMfaChallenge({ userId: user.id }, user.mfaMethod, {
        purpose: 'sign_in',
        destination: mfaCodeDestination(user.mfaMethod, user),
        destinationProven: true,
      });
      if (isMfaChallengeLimited(challenge)) {
        await sendMfaResendLimited(reply, challenge.retryAfterSeconds);
        return;
      }

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
          'Clears the MFA method, TOTP secret, recovery codes and passkeys of the user, ends every session of the user (API keys stay) and writes an mfa_reset audit row. For a user who lost the second factor. Requires users:write and every permission of the target user. Never available to the AI assistant or MCP.',
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
      const beforeCounts = await mfaFactorCounts({ userId: id });

      await db.transaction(async (tx) => {
        await tx
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
        await deleteRecoveryCodes({ userId: id }, tx);
        await deleteWebauthnCredentials({ userId: id }, tx);
      });
      await endUserSessions(id, { apiKeys: false });
      if (before.mfaEnabled || beforeCounts.passkeyCount > 0) {
        sendSecurityNotice(
          { userId: id },
          'security.FactorRemoved',
          { mfaTurnedOff: true, byAdmin: true },
          request.log,
          { textAccountPhone: before.mfaEnabled && before.mfaMethod === 'sms' },
        );
      }

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
      recoveryCodesRemaining: z
        .number()
        .int()
        .describe('Unused recovery codes of the user (0 without MFA)'),
      recoveryCodesUsedUp: z
        .boolean()
        .describe(
          'True when the user used every recovery code it was given (time to generate new ones); false when there are codes left or there never were any',
        ),
      requiredByPolicy: z
        .boolean()
        .describe(
          'True when required MFA (Settings > Security > MFA) covers the user role: MFA cannot be turned off',
        ),
      passkeyCount: z
        .number()
        .int()
        .describe('Passkeys and security keys the user registered (GET /v1/users/me/webauthn)'),
      webauthnEnabled: z
        .boolean()
        .describe(
          'Whether passkeys and security keys can be registered and used as a second factor',
        ),
      passkeyLoginEnabled: z
        .boolean()
        .describe('Whether a passkey can sign in without a password (Settings > Security > MFA)'),
      factorProofKinds: z
        .array(z.enum(FACTOR_PROOF_KINDS))
        .describe(
          'Proofs that adding a factor (passkey registration, MFA confirm) accepts with a session: the factors of the account, else password, else sso; empty for an account with none of them, which cannot add a factor',
        ),
      lastFactorIsPasskey: z
        .boolean()
        .describe(
          'True when the only factor is one passkey (no email, SMS or TOTP method): removing it turns MFA off and needs a proof (lastFactorProofKinds)',
        ),
      lastFactorProofKinds: z
        .array(z.enum(FACTOR_PROOF_KINDS))
        .describe(
          'Proofs that removing a factor (DELETE /v1/users/me/webauthn/:id) or turning MFA off (DELETE /v1/users/me/mfa) accepts: the factor kinds of factorProofKinds plus recovery_code while recovery codes remain; never password while the account holds a factor',
        ),
      ssoProofUntil: z
        .string()
        .nullable()
        .describe(
          'Until when this session can send the sso proof (ISO 8601): 10 minutes after its SSO sign-in; null without a recent SSO sign-in',
        ),
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
          roleId: users.roleId,
          mfaEnabled: users.mfaEnabled,
          mfaMethod: users.mfaMethod,
          email: users.email,
          phone: users.phone,
        })
        .from(users)
        .where(eq(users.id, userId));

      const mfaConfig = await getMfaConfig();
      // SMS codes need a phone number on the profile.
      const availableMethods = availableMfaMethods(mfaConfig, {
        email: user?.email ?? null,
        phone: user?.phone ?? null,
      });

      const counts = await mfaFactorCounts({ userId });
      const withMfa = user != null && hasMfa({ ...user, passkeyCount: counts.passkeyCount });
      const proofAccount = await proofAccountOf({ userId });
      return {
        mfaEnabled: user?.mfaEnabled ?? false,
        mfaMethod: user?.mfaMethod ?? null,
        availableMethods,
        recoveryCodesRemaining: withMfa ? counts.recoveryCodesRemaining : 0,
        recoveryCodesUsedUp: withMfa ? await recoveryCodesUsedUp({ userId }) : false,
        passkeyCount: counts.passkeyCount,
        webauthnEnabled: mfaConfig.webauthnEnabled,
        passkeyLoginEnabled: mfaConfig.passkeyLoginEnabled,
        factorProofKinds: proofAccount != null ? factorProofKindsOf(proofAccount) : [],
        // The rule of the removal service: no primary method and one passkey.
        lastFactorIsPasskey:
          user != null && !(user.mfaEnabled && user.mfaMethod != null) && counts.passkeyCount === 1,
        lastFactorProofKinds: proofAccount != null ? lastFactorProofKindsOf(proofAccount) : [],
        ssoProofUntil: ssoProofUntil(request)?.toISOString() ?? null,
        // Unreadable settings count as required: turning MFA off is refused then too.
        requiredByPolicy:
          user != null ? (await mfaPolicyForRole(user.roleId)) !== 'not_required' : false,
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
      onRequest: [selfServiceOrMfaEnrollment()],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Users'],
        summary: 'Start MFA setup',
        description:
          'Begins MFA enrollment for the requested method. For TOTP, returns the new secret and otpauth URI plus a QR code data URL. For email/SMS, dispatches a verification code to the user contact and returns a challengeId. Setup is not active until confirmed via the confirm endpoint, which takes the fresh proof of the account when called with a session. An account with a primary method answers 409 MFA_ALREADY_ENABLED; an account with passkeys only may add one. Takes a session, or the enrollmentToken of a sign-in that answered mfaEnrollmentRequired.',
        operationId: 'setupMfa',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaSetupBody),
        response: {
          200: itemResponse(mfaSetupResponse),
          400: errorWith('User not found or no phone for SMS codes', [
            ERROR_CODES.USER_NOT_FOUND,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          401: errorWith('Unauthorized', [
            ERROR_CODES.UNAUTHORIZED,
            ERROR_CODES.ACCOUNT_DEACTIVATED,
          ]),
          403: errorWith('MFA method disabled', [ERROR_CODES.MFA_METHOD_DISABLED]),
          409: errorWith('MFA is already enabled', [ERROR_CODES.MFA_ALREADY_ENABLED]),
          429: errorWith('Too many codes sent', [ERROR_CODES.MFA_RESEND_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string; roleId: string };
      const { method } = request.body as z.infer<typeof mfaSetupBody>;
      const enrolling = isMfaEnrollmentRequest(request);

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
      // first. Mirrors the same guard on the portal driver endpoint. An
      // enrollment token is accepted only while the account has no usable
      // factor (a method switched off), so its old secret is no longer trusted.
      if (user.mfaEnabled && !enrolling) {
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

      // Email or SMS: send verification code, under the resend cap. An SMS code goes
      // to a number the user has not proven yet: the code is bound to it and every
      // account's codes to that number count toward its cap.
      const challenge = await createAccountMfaChallenge({ userId }, method, {
        purpose: 'setup',
        destination: mfaCodeDestination(method, user),
      });
      if (isMfaChallengeLimited(challenge)) {
        await sendMfaResendLimited(reply, challenge.retryAfterSeconds);
        return;
      }

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
    proof: factorProof
      .optional()
      .describe(
        'With a session: fresh proof of the account (its current factor, else its password). Not needed with the enrollmentToken',
      ),
  });

  const mfaConfirmResponse = z
    .object({
      success: z.literal(true).describe('MFA is on'),
      recoveryCodes: z
        .array(z.string())
        .optional()
        .describe(
          'Ten single-use recovery codes (xxxxx-xxxxx), returned this once; absent when the account already has codes (a passkey-only account), which stay valid',
        ),
      token: z.string().optional().describe('Access JWT of the new session, also set as a cookie'),
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
        .describe('With an enrollmentToken: the user now signed in'),
      role: z
        .object({
          id: z.string().describe('Role identifier'),
          name: z.string().describe('Role display name'),
        })
        .passthrough()
        .nullable()
        .optional()
        .describe('With an enrollmentToken: the role of the user now signed in'),
    })
    .passthrough();

  app.post(
    '/users/me/mfa/confirm',
    {
      onRequest: [selfServiceOrMfaEnrollment()],
      schema: {
        tags: ['Users'],
        summary: 'Confirm MFA setup with verification code',
        description:
          'Verifies the supplied code against the in-flight MFA setup (TOTP secret or email/SMS challenge). With a session it first needs a fresh proof of the account in proof: its current factor when it has one (a passkey, see POST /v1/users/me/mfa/factor-proof), else its password, else a fresh SSO sign-in (sso); an account with none of them is refused, and a missing or wrong kind of proof answers 400 VALIDATION_ERROR with the accepted proofKinds. On success, persists the secret (encrypted for TOTP), flips mfaEnabled=true on the user and returns ten single-use recovery codes, shown this once; an account that already has recovery codes keeps them and gets none. Returns 400 if the code is invalid or the setup has expired. With the enrollmentToken of a sign-in that answered mfaEnrollmentRequired, it also signs the user in (session cookies, token, user and role) and the token stops working.',
        operationId: 'confirmMfa',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaConfirmBody),
        response: {
          200: itemResponse(mfaConfirmResponse),
          400: errorWith(
            'Bad request, or the proof is missing or wrong',
            [
              ERROR_CODES.INVALID_PASSWORD,
              ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
              ERROR_CODES.MFA_CODE_INVALID,
              ERROR_CODES.TOTP_NOT_CONFIGURED,
              ERROR_CODES.VALIDATION_ERROR,
              ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
              ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
            ],
            {
              proofKinds: z
                .array(z.enum(FACTOR_PROOF_KINDS))
                .optional()
                .describe(
                  'VALIDATION_ERROR of a missing or wrong proof: the proof kinds the account accepts',
                ),
            },
          ),
          401: errorWith('Unauthorized', [
            ERROR_CODES.UNAUTHORIZED,
            ERROR_CODES.ACCOUNT_DEACTIVATED,
          ]),
          403: errorWith('MFA method disabled', [ERROR_CODES.MFA_METHOD_DISABLED]),
          409: errorWith('MFA is already enabled', [ERROR_CODES.MFA_ALREADY_ENABLED]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string; roleId: string };
      const { method, code, challengeId, proof } = request.body as z.infer<typeof mfaConfirmBody>;
      const enrolling = isMfaEnrollmentRequest(request);

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
          totpSecretEnc: users.totpSecretEnc,
          mfaEnabled: users.mfaEnabled,
          phone: users.phone,
        })
        .from(users)
        .where(eq(users.id, userId));
      // Switching the method of an active MFA goes through the password-gated
      // disable and a new setup, like the setup step itself. An enrollment
      // token replaces a switched-off method that was the only factor.
      if (user?.mfaEnabled === true && !enrolling) {
        await reply
          .status(409)
          .send({ error: 'MFA is already enabled', code: 'MFA_ALREADY_ENABLED' });
        return;
      }

      // A stolen session cannot add a factor: it must prove the account first.
      if (!enrolling) {
        const refused = await checkFactorProof(request, { userId }, proof);
        if (refused != null) {
          await sendFactorProofRefusal(reply, refused);
          return;
        }
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
        // The code must have been sent for the method being confirmed, and an SMS
        // code to the number the user has now.
        verified =
          (await verifyMfaChallenge(client, challengeId, code, {
            userId,
            method,
            purpose: 'setup',
            destination: mfaCodeDestination(method, { phone: user?.phone ?? null }),
          })) === 'verified';
      }

      if (!verified) {
        await reply
          .status(400)
          .send({ error: 'Invalid verification code', code: 'MFA_CODE_INVALID' });
        return;
      }

      // The confirming TOTP code cannot be replayed at the next sign-in. With
      // an enrollment token the same UPDATE raises the session version only
      // while it is still the token's, so of two parallel confirms one wins
      // and the new version ends the token.
      const enrollmentVersion = enrolling ? (request.user as { sv?: unknown }).sv : undefined;
      const [enabled] = await db
        .update(users)
        .set({
          mfaEnabled: true,
          mfaMethod: method,
          totpLastStep: totpStep,
          mfaFailedCount: 0,
          mfaLockedUntil: null,
          updatedAt: new Date(),
          ...(enrolling ? { sessionVersion: sql`${users.sessionVersion} + 1` } : {}),
        })
        .where(
          enrolling
            ? and(
                eq(users.id, userId),
                eq(
                  users.sessionVersion,
                  typeof enrollmentVersion === 'number' ? enrollmentVersion : 0,
                ),
              )
            : eq(users.id, userId),
        )
        .returning({ sessionVersion: users.sessionVersion });

      // End every other session (session version and refresh tokens) and
      // give this browser a new one; API keys stay.
      let sessionVersion: number;
      if (enrolling) {
        // Another confirm with the same token won: it already issued the session.
        if (enabled == null) {
          await reply.status(401).send({ error: 'Session ended', code: 'UNAUTHORIZED' });
          return;
        }
        await revokeAllUserSessions(userId);
        announceSessionChange(userId);
        sessionVersion = enabled.sessionVersion;
      } else {
        sessionVersion = (await endUserSessions(userId, { apiKeys: false })) ?? 0;
      }
      const token = await issueOperatorSession(app, request, reply, {
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
      // A passkey-only account already had MFA: the method is an added factor.
      const passkeysBefore = await countWebauthnCredentials({ userId });
      sendSecurityNotice(
        { userId },
        'security.FactorAdded',
        { mfaTurnedOn: passkeysBefore === 0, ...factorFlags(method) },
        request.log,
      );

      // An account with passkeys already holds recovery codes: they stay valid.
      const recoveryCodes =
        (await countRecoveryCodes({ userId })) > 0
          ? undefined
          : await issueRecoveryCodes({ userId }, 'generated', { actor, log: request.log });
      if (!enrolling) {
        return { success: true as const, ...(recoveryCodes != null ? { recoveryCodes } : {}) };
      }

      // The enrollment finishes the sign-in that required it.
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
      await recordAuthAudit(request, {
        kind: 'user',
        accountId: userId,
        action: 'login_succeeded',
        method: 'mfa_enrollment',
      });
      const [signedIn] = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          language: users.language,
          timezone: users.timezone,
          themePreference: users.themePreference,
          roleId: roles.id,
          roleName: roles.name,
        })
        .from(users)
        .leftJoin(roles, eq(roles.id, users.roleId))
        .where(eq(users.id, userId));
      return {
        success: true as const,
        ...(recoveryCodes != null ? { recoveryCodes } : {}),
        token,
        ...(signedIn != null
          ? {
              user: {
                id: signedIn.id,
                email: signedIn.email,
                firstName: signedIn.firstName,
                lastName: signedIn.lastName,
                language: signedIn.language,
                timezone: signedIn.timezone,
                themePreference: signedIn.themePreference,
              },
              role:
                signedIn.roleId != null && signedIn.roleName != null
                  ? { id: signedIn.roleId, name: signedIn.roleName }
                  : null,
            }
          : {}),
      };
    },
  );

  const mfaDisableBody = z.object({
    proof: factorProof
      .optional()
      .describe(
        'Fresh proof of a factor the account holds (TOTP, an emailed or texted code, a passkey) or one of its recovery codes: the kinds GET /v1/users/me/mfa lists in lastFactorProofKinds. The password alone is not enough while the account holds a factor',
      ),
  });

  app.delete(
    '/users/me/mfa',
    {
      onRequest: [selfService()],
      // Throttle so a stolen session cookie can't be used to guess the proof.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Users'],
        summary: 'Disable MFA',
        description:
          'Requires a fresh proof of a factor the account holds or a recovery code (proof, kinds in lastFactorProofKinds of GET /v1/users/me/mfa), then clears mfaEnabled, mfaMethod, the encrypted TOTP secret, the recovery codes and the passkeys and security keys. The next login will skip the MFA challenge. The password alone is not accepted while the account holds a factor. Returns 400 VALIDATION_ERROR with proofKinds for a missing proof, MFA_CODE_INVALID or MFA_CHALLENGE_EXHAUSTED for a wrong code, WEBAUTHN_CHALLENGE_EXPIRED or WEBAUTHN_VERIFICATION_FAILED for a passkey, 409 MFA_REQUIRED_BY_POLICY while required MFA (Settings > Security > MFA) covers the user role, and 503 MFA_POLICY_UNAVAILABLE when the MFA settings cannot be read.',
        operationId: 'disableMfa',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaDisableBody),
        response: {
          200: successResponse,
          400: errorWith(
            'Bad request',
            [
              ERROR_CODES.VALIDATION_ERROR,
              ERROR_CODES.INVALID_PASSWORD,
              ERROR_CODES.MFA_CODE_INVALID,
              ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
              ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
              ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
              ERROR_CODES.USER_NOT_FOUND,
            ],
            {
              proofKinds: z
                .array(z.enum(FACTOR_PROOF_KINDS))
                .optional()
                .describe(
                  'VALIDATION_ERROR of a missing or wrong proof: the proof kinds the account accepts',
                ),
            },
          ),
          409: errorWith('Required MFA covers the user', [ERROR_CODES.MFA_REQUIRED_BY_POLICY]),
          503: errorWith('MFA settings unavailable', [ERROR_CODES.MFA_POLICY_UNAVAILABLE]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string; roleId: string };
      const { proof } = request.body as z.infer<typeof mfaDisableBody>;

      const [user] = await db
        .select({
          roleId: users.roleId,
          mfaEnabled: users.mfaEnabled,
          mfaMethod: users.mfaMethod,
        })
        .from(users)
        .where(eq(users.id, userId));

      if (user == null) {
        await reply.status(400).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      // Required MFA keeps MFA on; an admin MFA reset is the way to change the method.
      const policy = await mfaPolicyForRole(user.roleId);
      if (policy === 'unavailable') {
        await sendMfaPolicyUnavailable(request, reply, userId);
        return;
      }
      if (policy === 'required') {
        await reply.status(409).send({
          error: 'MFA is required for your role and cannot be turned off',
          code: 'MFA_REQUIRED_BY_POLICY',
        });
        return;
      }

      // A factor or a recovery code, never the password alone: a stolen session with a
      // phished password must not strip the factors that protect the account.
      const refused = await checkFactorProof(request, { userId }, proof, 'remove');
      if (refused != null) {
        await sendFactorProofRefusal(reply, refused);
        return;
      }

      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({
            mfaEnabled: false,
            mfaMethod: null,
            totpSecretEnc: null,
            totpLastStep: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
        await deleteRecoveryCodes({ userId }, tx);
        await deleteWebauthnCredentials({ userId }, tx);
      });

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
      sendSecurityNotice(
        { userId },
        'security.FactorRemoved',
        { mfaTurnedOff: true, byAdmin: false },
        request.log,
        { textAccountPhone: user.mfaEnabled && user.mfaMethod === 'sms' },
      );

      return { success: true };
    },
  );

  const recoveryCodesBody = z.object({
    code: z
      .string()
      .min(6)
      .max(6)
      .optional()
      .describe(
        'Code of the current MFA method. For email or SMS, omit it first to have a code sent',
      ),
    challengeId: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Challenge ID of the email or SMS code'),
    credential: authenticationCredential
      .optional()
      .describe(
        'A passkey or security key as the proof instead of a code: the navigator.credentials.get response to POST /v1/users/me/mfa/recovery-codes/webauthn-options',
      ),
  });

  const recoveryCodesResponse = z
    .object({
      recoveryCodes: z
        .array(z.string())
        .optional()
        .describe('Ten new single-use recovery codes (xxxxx-xxxxx), returned this once'),
      challengeId: z
        .number()
        .int()
        .optional()
        .describe('Set when an email or SMS code was sent: send it back with the code'),
    })
    .passthrough();

  app.post(
    '/users/me/mfa/recovery-codes',
    {
      onRequest: [selfService()],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Users'],
        summary: 'Replace the MFA recovery codes',
        description:
          'Proves the current MFA method or a passkey, then replaces the recovery codes with ten new ones and returns them this once; the old codes stop working. TOTP: send the code. Email or SMS: a call without code sends one and returns its challengeId, then send code and challengeId. Passkey or security key: send credential, the response to POST /v1/users/me/mfa/recovery-codes/webauthn-options (400 WEBAUTHN_CHALLENGE_EXPIRED or WEBAUTHN_VERIFICATION_FAILED when it does not verify).',
        operationId: 'regenerateMfaRecoveryCodes',
        security: [{ bearerAuth: [] }],
        body: zodSchema(recoveryCodesBody),
        response: {
          200: itemResponse(recoveryCodesResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.MFA_CODE_INVALID,
            ERROR_CODES.MFA_NOT_CONFIGURED,
            ERROR_CODES.TOTP_NOT_CONFIGURED,
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
            ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
          ]),
          429: errorWith('Too many codes sent', [ERROR_CODES.MFA_RESEND_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { code, challengeId, credential } = request.body as z.infer<typeof recoveryCodesBody>;

      // A passkey-only account has no method to send or check a code: its passkey is the proof.
      if (credential != null) {
        if (code != null) {
          await reply
            .status(400)
            .send({ error: 'Send a code or a passkey, not both', code: 'VALIDATION_ERROR' });
          return;
        }
        const proof = await verifyRecoveryCodesPasskey(
          request,
          { userId },
          credential as unknown as AuthenticationResponseJSON,
        );
        if (proof === 'challenge_expired') {
          await reply.status(400).send({
            error: 'The passkey request expired or was already used',
            code: 'WEBAUTHN_CHALLENGE_EXPIRED',
          });
          return;
        }
        if (proof === 'failed') {
          await reply.status(400).send({
            error: 'The passkey or security key could not be verified',
            code: 'WEBAUTHN_VERIFICATION_FAILED',
          });
          return;
        }
        const recoveryCodes = await issueRecoveryCodes({ userId }, 'regenerated', {
          actor: getAuditActor(request),
          log: request.log,
        });
        return { recoveryCodes };
      }

      const [user] = await db
        .select({
          mfaEnabled: users.mfaEnabled,
          mfaMethod: users.mfaMethod,
          totpSecretEnc: users.totpSecretEnc,
          email: users.email,
          phone: users.phone,
          firstName: users.firstName,
          language: users.language,
        })
        .from(users)
        .where(eq(users.id, userId));
      if (user == null || !user.mfaEnabled || user.mfaMethod == null) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }

      if (code == null) {
        if (user.mfaMethod === 'totp') {
          await reply.status(400).send({
            error: 'Send the code from your authenticator app',
            code: 'VALIDATION_ERROR',
          });
          return;
        }
        const challenge = await createAccountMfaChallenge({ userId }, user.mfaMethod, {
          purpose: 'proof',
          destination: mfaCodeDestination(user.mfaMethod, user),
          destinationProven: true,
        });
        if (isMfaChallengeLimited(challenge)) {
          await sendMfaResendLimited(reply, challenge.retryAfterSeconds);
          return;
        }
        await dispatchSystemNotification(
          client,
          'mfa.VerificationCode',
          mfaCodeRecipient(user.mfaMethod, user),
          { code: challenge.code },
          TEMPLATES_DIR,
        );
        return { challengeId: challenge.challengeId };
      }

      if (user.mfaMethod === 'totp' && user.totpSecretEnc == null) {
        await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
        return;
      }
      // While the proof backoff locks the account the code is not checked, as in the factor
      // proof. The try is counted in the UPDATE that checks the lock, so parallel guesses
      // cannot pass it; it counts apart from sign-in, so wrong guesses never lock the sign-in.
      const attempt = await takeSignInAttempt({ userId }, 'proof');
      if (!attempt.granted) {
        await reply
          .status(400)
          .send({ error: 'Invalid verification code', code: 'MFA_CODE_INVALID' });
        return;
      }

      let verified = false;
      if (user.mfaMethod === 'totp' && user.totpSecretEnc != null) {
        let step: number | null = null;
        try {
          step = matchTotpStep(
            decryptString(user.totpSecretEnc, apiConfig.SETTINGS_ENCRYPTION_KEY),
            code,
          );
        } catch (err: unknown) {
          request.log.warn({ err, userId }, 'TOTP secret decrypt failed');
        }
        // A code is accepted once, as at sign-in.
        if (step != null) verified = await acceptTotpStep({ userId }, step);
      } else if (challengeId != null) {
        verified =
          (await verifyMfaChallenge(client, challengeId, code, {
            userId,
            method: user.mfaMethod,
            purpose: 'proof',
            destination: mfaCodeDestination(user.mfaMethod, user),
          })) === 'verified';
      }
      if (!verified) {
        await recordAttemptFailure(request, attempt);
        await reply
          .status(400)
          .send({ error: 'Invalid verification code', code: 'MFA_CODE_INVALID' });
        return;
      }
      await clearSignInFailures({ userId }, 'proof');

      const recoveryCodes = await issueRecoveryCodes({ userId }, 'regenerated', {
        actor: getAuditActor(request),
        log: request.log,
      });
      return { recoveryCodes };
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
