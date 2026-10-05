// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  settings,
  writeAudit,
  settingAuditLog,
  clearPncSettingsCache,
} from '@evtivity/database';
import {
  encryptString,
  isPrivateUrl,
  parseAllowedPrivateHosts,
  MAX_ALLOWED_PRIVATE_HOSTS,
} from '@evtivity/lib';
import { decryptForRead } from '../lib/settings-crypto.js';
import { zodSchema } from '../lib/zod-schema.js';
import { successResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { config as apiConfig } from '../lib/config.js';

const testProviderResponse = z
  .object({ success: z.boolean().describe('Whether the provider connectivity test succeeded') })
  .passthrough();

const PNC_KEYS = [
  'pnc.enabled',
  'pnc.provider',
  'pnc.hubject.baseUrl',
  'pnc.hubject.clientId',
  'pnc.hubject.clientSecretEnc',
  'pnc.hubject.tokenUrl',
  'pnc.expirationWarningDays',
  'pnc.expirationCriticalDays',
  'pnc.ocsp.allowedPrivateHosts',
  'pnc.local.emaidCountry',
  'pnc.local.emaidProviderId',
];

// Checked in the handler (parseAllowedPrivateHosts): zod-to-json-schema strips
// .refine(), .trim(), and .toLowerCase(), and Fastify validates the body with
// the JSON Schema only.
const ocspAllowedHost = z.string().max(253);

const updatePncSettingsBody = z.object({
  enabled: z.boolean().optional().describe('Enable or disable Plug and Charge'),
  provider: z
    .enum(['manual', 'hubject', 'local'])
    .optional()
    .describe('PKI provider type (local: the CSMS issues contract certificates from its own CA)'),
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
  localEmaidCountry: z
    .string()
    .regex(/^([A-Z]{2})?$/)
    .optional()
    .describe('ISO 3166-1 alpha-2 country code of the eMAIDs the local contract CA issues'),
  localEmaidProviderId: z
    .string()
    .regex(/^([A-Z0-9]{3})?$/)
    .optional()
    .describe('Three character eMobility provider ID of the eMAIDs the local contract CA issues'),
  ocspAllowedPrivateHosts: z
    .array(ocspAllowedHost)
    .max(MAX_ALLOWED_PRIVATE_HOSTS)
    .optional()
    .describe(
      'Private or internal hosts the CSMS may send OCSP requests to (hostname or IP, no scheme or port)',
    ),
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
      // Push the PNC_KEYS filter to Postgres instead of selecting every
      // settings row and discarding the rest in JS.
      const rows = await db
        .select()
        .from(settings)
        .where(inArray(settings.key, [...PNC_KEYS]));
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        result[row.key] = decryptForRead(row.key, row.value);
      }
      return result;
    },
  );

  app.put(
    '/pnc/settings',
    {
      onRequest: [authorize('settings.integrations:write')],
      schema: {
        tags: ['PnC'],
        summary: 'Update Plug and Charge settings',
        operationId: 'updatePncSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updatePncSettingsBody),
        response: {
          200: successResponse,
          400: errorWith('Private url or invalid OCSP host', [
            ERROR_CODES.PRIVATE_URL,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
        },
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

      const ocspHosts =
        body.ocspAllowedPrivateHosts !== undefined
          ? parseAllowedPrivateHosts(body.ocspAllowedPrivateHosts)
          : undefined;
      if (ocspHosts === null) {
        await reply.status(400).send({
          error: 'OCSP allowed hosts must be hostnames or IP addresses without scheme or port',
          code: 'VALIDATION_ERROR',
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
      if (ocspHosts !== undefined) {
        updates.push({ key: 'pnc.ocsp.allowedPrivateHosts', value: ocspHosts });
      }
      if (body.localEmaidCountry !== undefined) {
        updates.push({ key: 'pnc.local.emaidCountry', value: body.localEmaidCountry });
      }
      if (body.localEmaidProviderId !== undefined) {
        updates.push({ key: 'pnc.local.emaidProviderId', value: body.localEmaidProviderId });
      }

      // Snapshot prior values so the audit entries can carry an honest
      // before/after. Settings page changes for PnC are operator-visible
      // security configuration; missing audit was a compliance gap.
      const keysToWrite = updates.map((u) => u.key);
      const beforeRows =
        keysToWrite.length > 0
          ? await db.select().from(settings).where(inArray(settings.key, keysToWrite))
          : [];
      const beforeMap = new Map<string, unknown>();
      for (const row of beforeRows) beforeMap.set(row.key, row.value);

      for (const update of updates) {
        await db
          .insert(settings)
          .values({ key: update.key, value: update.value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: update.value, updatedAt: new Date() },
          });
      }

      // Invalidate the in-process pnc.enabled cache so OCPP authorize
      // handlers and other readers pick up the flip immediately instead of
      // waiting up to 60 seconds for the TTL to expire.
      clearPncSettingsCache();

      const actor = getAuditActor(request);
      await Promise.allSettled(
        updates
          .filter(
            (update) => JSON.stringify(beforeMap.get(update.key)) !== JSON.stringify(update.value),
          )
          .map((update) =>
            writeAudit(
              { table: settingAuditLog, idColumn: 'setting_key' },
              {
                entityId: update.key,
                entityIdSnapshot: update.key,
                action: 'updated',
                ...actor,
                before: { key: update.key, value: beforeMap.get(update.key) },
                after: { key: update.key, value: update.value },
              },
              db,
              request.log,
            ),
          ),
      );

      return { success: true };
    },
  );

  app.post(
    '/pnc/settings/test-provider',
    {
      onRequest: [authorize('settings.integrations:write')],
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
        const rows = await db
          .select()
          .from(settings)
          .where(inArray(settings.key, [...PNC_KEYS]));
        const settingsMap = new Map<string, unknown>();
        for (const row of rows) {
          settingsMap.set(row.key, row.value);
        }

        const providerType =
          typeof settingsMap.get('pnc.provider') === 'string'
            ? (settingsMap.get('pnc.provider') as string)
            : 'manual';

        if (providerType === 'manual') {
          return { success: true, provider: 'manual' };
        }

        if (providerType === 'local') {
          // The local provider needs its CA and an eMAID prefix for contracts.
          const [caRow] = await db
            .select({ value: settings.value })
            .from(settings)
            .where(eq(settings.key, 'pnc.local.caEnc'));
          const country = settingsMap.get('pnc.local.emaidCountry');
          const providerId = settingsMap.get('pnc.local.emaidProviderId');
          if (
            typeof caRow?.value !== 'string' ||
            caRow.value === '' ||
            typeof country !== 'string' ||
            country === '' ||
            typeof providerId !== 'string' ||
            providerId === ''
          ) {
            await reply.status(400).send({
              success: false,
              error:
                'The local provider requires a contract CA and an eMAID country and provider ID',
            });
            return;
          }
          return { success: true, provider: 'local' };
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
          await reply.status(502).send({
            error: `Provider returned ${String(response.status)}`,
            code: 'PROVIDER_TEST_FAILED',
          });
          return;
        }

        // 401/403 is expected without auth - it means the endpoint is reachable
        return { success: true, provider: providerType };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await reply.status(502).send({ error: message, code: 'PROVIDER_TEST_FAILED' });
        return;
      }
    },
  );
}
