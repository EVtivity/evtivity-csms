// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { like, inArray } from 'drizzle-orm';
import {
  db,
  settings,
  clearSecuritySettingsCache,
  writeAudit,
  settingAuditLog,
} from '@evtivity/database';
import {
  createLogger,
  encryptString,
  normalizePasswordPolicy,
  normalizeSessionLifetimes,
  PASSWORD_MIN_LENGTH_CEILING,
  PASSWORD_MIN_LENGTH_FLOOR,
  SESSION_LIFETIME_LIMITS,
} from '@evtivity/lib';
import { decryptForRead } from '../lib/settings-crypto.js';
import { zodSchema } from '../lib/zod-schema.js';
import { successResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { config as apiConfig } from '../lib/config.js';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { requireAllSiteAccess } from '../lib/site-access.js';

// reCAPTCHA and MFA protect every operator and driver sign-in: company-wide,
// so a site-restricted user gets this 404 before any read or write
// (requireAllSiteAccess, features/site-access-control.md).
const ALL_SITES_SETTING_NOT_FOUND = {
  error: 'Setting not found',
  code: 'SETTING_NOT_FOUND',
} as const;

const logger = createLogger('security-settings');

async function invalidateSecuritySettings(): Promise<void> {
  clearSecuritySettingsCache();
  try {
    await getPubSub().publish('cache_invalidate', JSON.stringify({ kind: 'security_settings' }));
  } catch (err) {
    logger.warn({ err }, 'Security settings invalidation publish failed, peers refresh within 60s');
  }
}

// Read prior values for the keys we're about to write so the audit row can
// carry a faithful before/after. Returns a Map keyed by setting key.
async function loadCurrentValues(keys: string[]): Promise<Map<string, unknown>> {
  if (keys.length === 0) return new Map();
  const rows = await db.select().from(settings).where(inArray(settings.key, keys));
  const map = new Map<string, unknown>();
  for (const row of rows) {
    map.set(row.key, row.value);
  }
  return map;
}

// Write one audit row per setting key that actually changed. Skipping
// unchanged keys keeps the audit log free of no-op rows from operators who
// just re-saved an unchanged form. Audit JSONB carries the real values so
// operators can see what changed.
async function auditSettingChanges(
  request: FastifyRequest,
  before: Map<string, unknown>,
  after: Array<{ key: string; value: unknown }>,
): Promise<void> {
  const actor = getAuditActor(request);
  await Promise.allSettled(
    after
      .filter(({ key, value }) => before.get(key) !== value)
      .map(({ key, value }) =>
        writeAudit(
          { table: settingAuditLog, idColumn: 'setting_key' },
          {
            entityId: key,
            entityIdSnapshot: key,
            action: 'updated',
            ...actor,
            before: { key, value: before.get(key) },
            after: { key, value },
          },
          db,
          request.log,
        ),
      ),
  );
}

const SECURITY_KEYS = [
  'security.recaptcha.enabled',
  'security.recaptcha.siteKey',
  'security.recaptcha.secretKeyEnc',
  'security.recaptcha.threshold',
  'security.mfa.emailEnabled',
  'security.mfa.totpEnabled',
  'security.mfa.smsEnabled',
  'security.password.minLength',
  'security.password.requireUppercase',
  'security.password.requireLowercase',
  'security.password.requireNumber',
  'security.password.requireSymbol',
  'security.session.operatorAccessMinutes',
  'security.session.operatorRefreshDays',
  'security.session.driverAccessMinutes',
  'security.session.driverRefreshDays',
];

const passwordPolicyBody = z.object({
  minLength: z
    .number()
    .int()
    .min(PASSWORD_MIN_LENGTH_FLOOR)
    .max(PASSWORD_MIN_LENGTH_CEILING)
    .describe(
      `Minimum password length (${String(PASSWORD_MIN_LENGTH_FLOOR)} to ${String(PASSWORD_MIN_LENGTH_CEILING)})`,
    ),
  requireUppercase: z.boolean().describe('Require at least one uppercase letter'),
  requireLowercase: z.boolean().describe('Require at least one lowercase letter'),
  requireNumber: z.boolean().describe('Require at least one digit'),
  requireSymbol: z
    .boolean()
    .describe('Require at least one ASCII character that is not a letter, digit or space'),
});

function lifetimeField(field: keyof typeof SESSION_LIFETIME_LIMITS, text: string) {
  const { min, max } = SESSION_LIFETIME_LIMITS[field];
  return z
    .number()
    .int()
    .min(min)
    .max(max)
    .describe(`${text} (${String(min)} to ${String(max)})`);
}

const sessionLifetimesBody = z.object({
  operatorAccessMinutes: lifetimeField(
    'operatorAccessMinutes',
    'Operator access token lifetime in minutes',
  ),
  operatorRefreshDays: lifetimeField(
    'operatorRefreshDays',
    'Operator refresh token lifetime in days',
  ),
  driverAccessMinutes: lifetimeField(
    'driverAccessMinutes',
    'Driver access token lifetime in minutes',
  ),
  driverRefreshDays: lifetimeField('driverRefreshDays', 'Driver refresh token lifetime in days'),
});

const securitySettingsResponse = z
  .object({
    passwordPolicy: passwordPolicyBody.describe(
      'Password policy in effect, with defaults for unset keys',
    ),
    sessionLifetimes: sessionLifetimesBody.describe(
      'Access and refresh token lifetimes in effect, with defaults for unset keys',
    ),
  })
  .passthrough()
  .describe('Stored security.* setting keys, plus the parsed password and session groups');

const PASSWORD_KEYS: Record<keyof z.infer<typeof passwordPolicyBody>, string> = {
  minLength: 'security.password.minLength',
  requireUppercase: 'security.password.requireUppercase',
  requireLowercase: 'security.password.requireLowercase',
  requireNumber: 'security.password.requireNumber',
  requireSymbol: 'security.password.requireSymbol',
};

const SESSION_KEYS: Record<keyof z.infer<typeof sessionLifetimesBody>, string> = {
  operatorAccessMinutes: 'security.session.operatorAccessMinutes',
  operatorRefreshDays: 'security.session.operatorRefreshDays',
  driverAccessMinutes: 'security.session.driverAccessMinutes',
  driverRefreshDays: 'security.session.driverRefreshDays',
};

function withPrefix(rows: Array<{ key: string; value: unknown }>, prefix: string) {
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.key.startsWith(prefix)) result[row.key.slice(prefix.length)] = row.value;
  }
  return result;
}

function upsertSetting(executor: Pick<typeof db, 'insert'>, key: string, value: unknown) {
  return executor
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
}

// One transaction per save: a failed write leaves every key of the form as it was.
async function writeSettings(written: Array<{ key: string; value: unknown }>): Promise<void> {
  await db.transaction(async (tx) => {
    for (const w of written) await upsertSetting(tx, w.key, w.value);
  });
}

const recaptchaBody = z.object({
  enabled: z.boolean().describe('Enable or disable reCAPTCHA v3'),
  siteKey: z.string().describe('Google reCAPTCHA v3 site key'),
  secretKey: z.string().optional().describe('Google reCAPTCHA v3 secret key (stored encrypted)'),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .describe('Score threshold (0.0 to 1.0). Requests below this score are rejected.'),
});

const mfaBody = z.object({
  emailEnabled: z.boolean().describe('Allow MFA via email code'),
  totpEnabled: z.boolean().describe('Allow MFA via authenticator app (TOTP)'),
  smsEnabled: z.boolean().describe('Allow MFA via SMS code'),
});

function getEncryptionKey(): string {
  const key = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (key === '') {
    throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  }
  return key;
}

export function securitySettingsRoutes(app: FastifyInstance): void {
  app.get(
    '/security/settings',
    {
      onRequest: [authorize('settings.security:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get all security settings',
        operationId: 'getSecuritySettings',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(securitySettingsResponse),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const rows = await db.select().from(settings).where(like(settings.key, 'security.%'));
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        if (!SECURITY_KEYS.includes(row.key)) continue;
        result[row.key] = decryptForRead(row.key, row.value);
      }
      return {
        ...result,
        passwordPolicy: normalizePasswordPolicy(withPrefix(rows, 'security.password.')),
        sessionLifetimes: normalizeSessionLifetimes(withPrefix(rows, 'security.session.')),
      };
    },
  );

  app.put(
    '/security/password-policy',
    {
      onRequest: [authorize('settings.security:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Update the password policy',
        description:
          'Applies at the next password set. Sign-in never checks the policy, so a stricter policy locks nobody out.',
        operationId: 'updatePasswordPolicySettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(passwordPolicyBody),
        response: {
          200: successResponse,
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const body = request.body as z.infer<typeof passwordPolicyBody>;
      const written = (Object.keys(PASSWORD_KEYS) as Array<keyof typeof PASSWORD_KEYS>).map(
        (field) => ({ key: PASSWORD_KEYS[field], value: body[field] }),
      );

      const before = await loadCurrentValues(written.map((w) => w.key));
      await writeSettings(written);
      await invalidateSecuritySettings();
      await auditSettingChanges(request, before, written);
      return { success: true };
    },
  );

  app.put(
    '/security/sessions',
    {
      onRequest: [authorize('settings.security:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Update the operator and driver session lifetimes',
        description:
          'Applies to tokens issued after the change, renewals included, so active sessions take on the new lifetimes at their next background renewal.',
        operationId: 'updateSessionLifetimeSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(sessionLifetimesBody),
        response: {
          200: successResponse,
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const body = request.body as z.infer<typeof sessionLifetimesBody>;
      const written = (Object.keys(SESSION_KEYS) as Array<keyof typeof SESSION_KEYS>).map(
        (field) => ({ key: SESSION_KEYS[field], value: body[field] }),
      );

      const before = await loadCurrentValues(written.map((w) => w.key));
      await writeSettings(written);
      await invalidateSecuritySettings();
      await auditSettingChanges(request, before, written);
      return { success: true };
    },
  );

  app.put(
    '/security/recaptcha',
    {
      onRequest: [authorize('settings.security:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Update reCAPTCHA v3 settings',
        operationId: 'updateRecaptchaSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(recaptchaBody),
        response: {
          200: successResponse,
          400: errorWith('Enabling reCAPTCHA without a secret key', [
            ERROR_CODES.RECAPTCHA_SECRET_REQUIRED,
          ]),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
          500: errorWith('Encryption key missing', [ERROR_CODES.ENCRYPTION_KEY_MISSING]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const body = request.body as z.infer<typeof recaptchaBody>;
      const secretKey = body.secretKey ?? '';
      const secretSent = secretKey !== '';

      // Enabled with no secret fails closed at runtime (recaptcha-check.ts), so
      // protected portal routes would return 500. Refuse the save instead.
      if (body.enabled && !secretSent) {
        const stored = await loadCurrentValues(['security.recaptcha.secretKeyEnc']);
        const storedSecret = stored.get('security.recaptcha.secretKeyEnc');
        if (typeof storedSecret !== 'string' || storedSecret === '') {
          await reply.status(400).send({
            error: 'A reCAPTCHA secret key is required to enable reCAPTCHA',
            code: 'RECAPTCHA_SECRET_REQUIRED',
          });
          return;
        }
      }

      const written: Array<{ key: string; value: unknown }> = [
        { key: 'security.recaptcha.enabled', value: body.enabled },
        { key: 'security.recaptcha.siteKey', value: body.siteKey },
        { key: 'security.recaptcha.threshold', value: body.threshold },
      ];

      if (secretSent) {
        try {
          const encrypted = encryptString(secretKey, getEncryptionKey());
          written.push({ key: 'security.recaptcha.secretKeyEnc', value: encrypted });
        } catch (err) {
          request.log.error(
            { err, key: 'security.recaptcha.secretKeyEnc' },
            'Encrypting the reCAPTCHA secret failed, nothing saved',
          );
          await reply.status(500).send({
            error: 'SETTINGS_ENCRYPTION_KEY not configured on server',
            code: 'ENCRYPTION_KEY_MISSING',
          });
          return;
        }
      }

      const before = await loadCurrentValues(written.map((w) => w.key));
      await writeSettings(written);
      await invalidateSecuritySettings();
      await auditSettingChanges(request, before, written);
      return { success: true };
    },
  );

  app.put(
    '/security/mfa',
    {
      onRequest: [authorize('settings.security:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Update MFA method availability',
        operationId: 'updateMfaSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaBody),
        response: {
          200: successResponse,
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const body = request.body as z.infer<typeof mfaBody>;

      const written: Array<{ key: string; value: unknown }> = [
        { key: 'security.mfa.emailEnabled', value: body.emailEnabled },
        { key: 'security.mfa.totpEnabled', value: body.totpEnabled },
        { key: 'security.mfa.smsEnabled', value: body.smsEnabled },
      ];

      const before = await loadCurrentValues(written.map((w) => w.key));
      await writeSettings(written);
      await invalidateSecuritySettings();
      await auditSettingChanges(request, before, written);
      return { success: true };
    },
  );
}
