// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, settings } from '@evtivity/database';
import { encryptString, isPrivateUrl } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { successResponse, itemResponse, errorResponse } from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';
import { config as apiConfig } from '../lib/config.js';

const testProviderResponse = z.object({ success: z.boolean() }).passthrough();

const PNC_KEYS = [
  'pnc.enabled',
  'pnc.provider',
  'pnc.hubject.baseUrl',
  'pnc.hubject.clientId',
  'pnc.hubject.clientSecretEnc',
  'pnc.hubject.tokenUrl',
  'pnc.expirationWarningDays',
  'pnc.expirationCriticalDays',
];

const updatePncSettingsBody = z.object({
  enabled: z.boolean().optional().describe('Enable or disable Plug and Charge'),
  provider: z.enum(['manual', 'hubject']).optional().describe('PKI provider type'),
  hubjectBaseUrl: z.string().optional().describe('Hubject OPCP API base URL'),
  hubjectClientId: z.string().optional().describe('Hubject OAuth2 client ID'),
  hubjectClientSecret: z
    .string()
    .optional()
    .describe('Hubject OAuth2 client secret (stored encrypted)'),
  hubjectTokenUrl: z.string().optional().describe('Hubject OAuth2 token endpoint URL'),
  expirationWarningDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe('Days before certificate expiry to show warning'),
  expirationCriticalDays: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe('Days before certificate expiry to trigger auto-renewal'),
});

function getEncryptionKey(): string {
  const key = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (key === '') {
    throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  }
  return key;
}

export function pncSettingsRoutes(app: FastifyInstance): void {
  app.get(
    '/pnc/settings',
    {
      onRequest: [authorize('settings.integrations:read')],
      schema: {
        tags: ['PnC'],
        summary: 'Get Plug and Charge settings',
        operationId: 'getPncSettings',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(z.record(z.unknown())) },
      },
    },
    async () => {
      const allRows = await db.select().from(settings);
      const result: Record<string, unknown> = {};
      for (const row of allRows) {
        if (PNC_KEYS.includes(row.key)) {
          if (row.key === 'pnc.hubject.clientSecretEnc') {
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
    '/pnc/settings',
    {
      onRequest: [authorize('settings.security:write')],
      schema: {
        tags: ['PnC'],
        summary: 'Update Plug and Charge settings',
        operationId: 'updatePncSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updatePncSettingsBody),
        response: { 200: successResponse, 400: errorResponse },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof updatePncSettingsBody>;

      if (
        body.hubjectBaseUrl !== undefined &&
        body.hubjectBaseUrl !== '' &&
        isPrivateUrl(body.hubjectBaseUrl)
      ) {
        await reply.status(400).send({
          error: 'Hubject base URL must not point to a private or internal address',
          code: 'PRIVATE_URL',
        });
        return;
      }

      const updates: Array<{ key: string; value: unknown }> = [];

      if (body.enabled !== undefined) {
        updates.push({ key: 'pnc.enabled', value: body.enabled });
      }
      if (body.provider !== undefined) {
        updates.push({ key: 'pnc.provider', value: body.provider });
      }
      if (body.hubjectBaseUrl !== undefined) {
        updates.push({ key: 'pnc.hubject.baseUrl', value: body.hubjectBaseUrl });
      }
      if (body.hubjectClientId !== undefined) {
        updates.push({ key: 'pnc.hubject.clientId', value: body.hubjectClientId });
      }
      if (body.hubjectClientSecret !== undefined && body.hubjectClientSecret !== '') {
        const encrypted = encryptString(body.hubjectClientSecret, getEncryptionKey());
        updates.push({ key: 'pnc.hubject.clientSecretEnc', value: encrypted });
      }
      if (body.hubjectTokenUrl !== undefined) {
        updates.push({ key: 'pnc.hubject.tokenUrl', value: body.hubjectTokenUrl });
      }
      if (body.expirationWarningDays !== undefined) {
        updates.push({ key: 'pnc.expirationWarningDays', value: body.expirationWarningDays });
      }
      if (body.expirationCriticalDays !== undefined) {
        updates.push({ key: 'pnc.expirationCriticalDays', value: body.expirationCriticalDays });
      }

      for (const update of updates) {
        await db
          .insert(settings)
          .values({ key: update.key, value: update.value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: update.value, updatedAt: new Date() },
          });
      }

      return { success: true };
    },
  );

  app.post(
    '/pnc/settings/test-provider',
    {
      onRequest: [authorize('settings.security:write')],
      schema: {
        tags: ['PnC'],
        summary: 'Test PnC provider connectivity',
        operationId: 'testPncProvider',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(testProviderResponse),
          400: itemResponse(testProviderResponse),
          502: itemResponse(testProviderResponse),
        },
      },
    },
    async (_request, reply) => {
      try {
        const allRows = await db.select().from(settings);
        const settingsMap = new Map<string, unknown>();
        for (const row of allRows) {
          if (PNC_KEYS.includes(row.key)) {
            settingsMap.set(row.key, row.value);
          }
        }

        const providerType =
          typeof settingsMap.get('pnc.provider') === 'string'
            ? (settingsMap.get('pnc.provider') as string)
            : 'manual';

        if (providerType === 'manual') {
          return { success: true, provider: 'manual' };
        }

        // For Hubject, verify required fields are configured
        const baseUrl = settingsMap.get('pnc.hubject.baseUrl');
        const clientId = settingsMap.get('pnc.hubject.clientId');
        const tokenUrl = settingsMap.get('pnc.hubject.tokenUrl');
        const secretEnc = settingsMap.get('pnc.hubject.clientSecretEnc');

        if (
          typeof baseUrl !== 'string' ||
          baseUrl === '' ||
          typeof clientId !== 'string' ||
          clientId === '' ||
          typeof tokenUrl !== 'string' ||
          tokenUrl === '' ||
          typeof secretEnc !== 'string' ||
          secretEnc === ''
        ) {
          await reply.status(400).send({
            success: false,
            error: 'Hubject provider requires baseUrl, clientId, clientSecret, and tokenUrl',
          });
          return;
        }

        // Attempt to reach the base URL as a connectivity check
        const testUrl = `${baseUrl}/.well-known/est/cacerts`;
        const response = await fetch(testUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok && response.status !== 401 && response.status !== 403) {
          await reply
            .status(502)
            .send({ success: false, error: `Provider returned ${String(response.status)}` });
          return;
        }

        // 401/403 is expected without auth - it means the endpoint is reachable
        return { success: true, provider: providerType };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await reply.status(502).send({ success: false, error: message });
        return;
      }
    },
  );
}
