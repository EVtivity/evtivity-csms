// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { like } from 'drizzle-orm';
import { db, settings, clearSsoSettingsCache } from '@evtivity/database';
import { encryptString } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { errorResponse, successResponse, itemResponse } from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';
import { config as apiConfig } from '../lib/config.js';

const SSO_KEYS = [
  'sso.enabled',
  'sso.provider',
  'sso.entryPoint',
  'sso.issuer',
  'sso.certEnc',
  'sso.autoProvision',
  'sso.defaultRoleId',
  'sso.attributeMapping',
];

const ssoSettingsBody = z.object({
  enabled: z.boolean().describe('Enable or disable SSO'),
  provider: z.string().describe('Identity provider hint: okta, azure-ad, google-workspace, custom'),
  entryPoint: z.string().describe('IdP SSO URL (entry point)'),
  issuer: z.string().describe('SP entity ID'),
  cert: z
    .string()
    .optional()
    .describe('IdP X.509 certificate PEM (stored encrypted). Only sent when changed.'),
  autoProvision: z.boolean().describe('Auto-create users from SAML assertions'),
  defaultRoleId: z.string().describe('Role assigned to auto-provisioned users'),
  attributeMapping: z.record(z.string()).describe('Maps IdP SAML attributes to user fields'),
});

function getEncryptionKey(): string {
  const key = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (key === '') {
    throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  }
  return key;
}

export function ssoSettingsRoutes(app: FastifyInstance): void {
  app.get(
    '/sso/settings',
    {
      onRequest: [authorize('settings.security:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get SSO (SAML 2.0) settings',
        operationId: 'getSsoSettings',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(z.record(z.unknown())) },
      },
    },
    async () => {
      const rows = await db.select().from(settings).where(like(settings.key, 'sso.%'));
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        if (SSO_KEYS.includes(row.key)) {
          if (row.key === 'sso.certEnc') {
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
    '/sso/settings',
    {
      onRequest: [authorize('settings.security:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Update SSO (SAML 2.0) settings',
        operationId: 'updateSsoSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(ssoSettingsBody),
        response: { 200: successResponse, 500: errorResponse },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof ssoSettingsBody>;

      const upsert = (key: string, value: unknown) =>
        db
          .insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });

      const updates = [
        upsert('sso.enabled', body.enabled),
        upsert('sso.provider', body.provider),
        upsert('sso.entryPoint', body.entryPoint),
        upsert('sso.issuer', body.issuer),
        upsert('sso.autoProvision', body.autoProvision),
        upsert('sso.defaultRoleId', body.defaultRoleId),
        upsert('sso.attributeMapping', JSON.stringify(body.attributeMapping)),
      ];

      if (body.cert !== undefined && body.cert !== '') {
        try {
          const encrypted = encryptString(body.cert, getEncryptionKey());
          updates.push(upsert('sso.certEnc', encrypted));
        } catch {
          await reply.status(500).send({
            error: 'SETTINGS_ENCRYPTION_KEY not configured on server',
            code: 'ENCRYPTION_KEY_MISSING',
          });
          return;
        }
      }

      await Promise.all(updates);
      clearSsoSettingsCache();
      return { success: true };
    },
  );
}
