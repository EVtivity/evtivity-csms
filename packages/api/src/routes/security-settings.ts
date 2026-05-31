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
import { encryptString } from '@evtivity/lib';
import { decryptForRead } from '../lib/settings-crypto.js';
import { zodSchema } from '../lib/zod-schema.js';
import { successResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { config as apiConfig } from '../lib/config.js';
import { getPubSub } from '../lib/pubsub.js';

async function invalidateSecuritySettings(): Promise<void> {
  clearSecuritySettingsCache();
  try {
    await getPubSub().publish('cache_invalidate', JSON.stringify({ kind: 'security_settings' }));
  } catch {
    // Non-critical: peers refresh from the 60s TTL anyway.
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
];

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
        response: { 200: itemResponse(z.record(z.unknown())) },
      },
    },
    async () => {
      const rows = await db.select().from(settings).where(like(settings.key, 'security.%'));
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        if (!SECURITY_KEYS.includes(row.key)) continue;
        result[row.key] = decryptForRead(row.key, row.value);
      }
      return result;
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
          500: errorWith('Encryption key missing', [ERROR_CODES.ENCRYPTION_KEY_MISSING]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof recaptchaBody>;

      const upsert = (key: string, value: unknown) =>
        db
          .insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });

      const written: Array<{ key: string; value: unknown }> = [
        { key: 'security.recaptcha.enabled', value: body.enabled },
        { key: 'security.recaptcha.siteKey', value: body.siteKey },
        { key: 'security.recaptcha.threshold', value: body.threshold },
      ];

      if (body.secretKey !== undefined && body.secretKey !== '') {
        try {
          const encrypted = encryptString(body.secretKey, getEncryptionKey());
          written.push({ key: 'security.recaptcha.secretKeyEnc', value: encrypted });
        } catch {
          await reply.status(500).send({
            error: 'SETTINGS_ENCRYPTION_KEY not configured on server',
            code: 'ENCRYPTION_KEY_MISSING',
          });
          return;
        }
      }

      const before = await loadCurrentValues(written.map((w) => w.key));
      await Promise.all(written.map((w) => upsert(w.key, w.value)));
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
        response: { 200: successResponse },
      },
    },
    async (request) => {
      const body = request.body as z.infer<typeof mfaBody>;

      const upsert = (key: string, value: unknown) =>
        db
          .insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });

      const written: Array<{ key: string; value: unknown }> = [
        { key: 'security.mfa.emailEnabled', value: body.emailEnabled },
        { key: 'security.mfa.totpEnabled', value: body.totpEnabled },
        { key: 'security.mfa.smsEnabled', value: body.smsEnabled },
      ];

      const before = await loadCurrentValues(written.map((w) => w.key));
      await Promise.all(written.map((w) => upsert(w.key, w.value)));
      await invalidateSecuritySettings();
      await auditSettingChanges(request, before, written);
      return { success: true };
    },
  );
}
