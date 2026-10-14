// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inArray, like } from 'drizzle-orm';
import {
  db,
  settings,
  clearSsoSettingsCache,
  writeAudit,
  settingAuditLog,
} from '@evtivity/database';
import { encryptString } from '@evtivity/lib';
import { decryptForRead } from '../lib/settings-crypto.js';
import { zodSchema } from '../lib/zod-schema.js';
import { successResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import { config as apiConfig } from '../lib/config.js';
import { requireAllSiteAccess } from '../lib/site-access.js';
import { getAuditActor } from '../lib/audit-actor.js';

// SSO decides who signs in as which operator: company-wide, so a
// site-restricted user gets this 404 before any read or write
// (requireAllSiteAccess, features/site-access-control.md).
const ALL_SITES_SETTING_NOT_FOUND = {
  error: 'Setting not found',
  code: 'SETTING_NOT_FOUND',
} as const;

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
        response: {
          200: itemResponse(z.record(z.unknown())),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const rows = await db.select().from(settings).where(like(settings.key, 'sso.%'));
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        if (!SSO_KEYS.includes(row.key)) continue;
        result[row.key] = decryptForRead(row.key, row.value);
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
        response: {
          200: successResponse,
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
          500: errorWith('Encryption key missing', [ERROR_CODES.ENCRYPTION_KEY_MISSING]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const body = request.body as z.infer<typeof ssoSettingsBody>;

      const upsert = (key: string, value: unknown) =>
        db
          .insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });

      const written: Array<{ key: string; value: unknown }> = [
        { key: 'sso.enabled', value: body.enabled },
        { key: 'sso.provider', value: body.provider },
        { key: 'sso.entryPoint', value: body.entryPoint },
        { key: 'sso.issuer', value: body.issuer },
        { key: 'sso.autoProvision', value: body.autoProvision },
        { key: 'sso.defaultRoleId', value: body.defaultRoleId },
        { key: 'sso.attributeMapping', value: JSON.stringify(body.attributeMapping) },
      ];

      if (body.cert !== undefined && body.cert !== '') {
        try {
          const encrypted = encryptString(body.cert, getEncryptionKey());
          written.push({ key: 'sso.certEnc', value: encrypted });
        } catch (err) {
          request.log.error(
            { err, key: 'sso.certEnc' },
            'Encrypting the SSO certificate failed, nothing saved',
          );
          await reply.status(500).send({
            error: 'SETTINGS_ENCRYPTION_KEY not configured on server',
            code: 'ENCRYPTION_KEY_MISSING',
          });
          return;
        }
      }

      const beforeRows = await db
        .select()
        .from(settings)
        .where(
          inArray(
            settings.key,
            written.map((w) => w.key),
          ),
        );
      const beforeMap = new Map<string, unknown>(beforeRows.map((row) => [row.key, row.value]));

      await Promise.all(written.map((w) => upsert(w.key, w.value)));
      clearSsoSettingsCache();

      // One setting.updated row per changed key. The certificate is stored as
      // ciphertext with a fresh IV on every write, so a sent certificate always
      // counts as a change and its row records only that it is configured.
      const actor = getAuditActor(request);
      await Promise.allSettled(
        written
          .filter(
            ({ key, value }) =>
              key.endsWith('Enc') || JSON.stringify(beforeMap.get(key)) !== JSON.stringify(value),
          )
          .map(({ key, value }) => {
            const secret = key.endsWith('Enc');
            return writeAudit(
              { table: settingAuditLog, idColumn: 'setting_key' },
              {
                entityId: key,
                entityIdSnapshot: key,
                action: 'updated',
                ...actor,
                before: secret
                  ? { key, configured: beforeMap.has(key) }
                  : { key, value: beforeMap.get(key) ?? null },
                after: secret ? { key, configured: true } : { key, value },
              },
              db,
              request.log,
            );
          }),
      );
      return { success: true };
    },
  );
}
