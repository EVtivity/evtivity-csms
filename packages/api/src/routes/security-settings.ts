// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { like } from 'drizzle-orm';
import { db, settings, clearSecuritySettingsCache } from '@evtivity/database';
import { encryptString } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { errorResponse, successResponse, itemResponse } from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';
import { config as apiConfig } from '../lib/config.js';

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
        if (SECURITY_KEYS.includes(row.key)) {
          if (row.key === 'security.recaptcha.secretKeyEnc') {
            result[row.key] = row.value != null && row.value !== '' ? '********' : '';
          } else {
            result[row.key] = row.value;
          }
        }
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
        response: { 200: successResponse, 500: errorResponse },
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

      const updates = [
        upsert('security.recaptcha.enabled', body.enabled),
        upsert('security.recaptcha.siteKey', body.siteKey),
        upsert('security.recaptcha.threshold', body.threshold),
      ];

      if (body.secretKey !== undefined && body.secretKey !== '') {
        try {
          const encrypted = encryptString(body.secretKey, getEncryptionKey());
          updates.push(upsert('security.recaptcha.secretKeyEnc', encrypted));
        } catch {
          await reply.status(500).send({
            error: 'SETTINGS_ENCRYPTION_KEY not configured on server',
            code: 'ENCRYPTION_KEY_MISSING',
          });
          return;
        }
      }

      await Promise.all(updates);
      clearSecuritySettingsCache();
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

      await Promise.all([
        upsert('security.mfa.emailEnabled', body.emailEnabled),
        upsert('security.mfa.totpEnabled', body.totpEnabled),
        upsert('security.mfa.smsEnabled', body.smsEnabled),
      ]);

      clearSecuritySettingsCache();
      return { success: true };
    },
  );
}
