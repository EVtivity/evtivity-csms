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
  safeFetch,
  parseAllowedPrivateHosts,
  MAX_ALLOWED_PRIVATE_HOSTS,
} from '@evtivity/lib';
import {
  readSettingsWithSecrets,
  SECRET_SETTINGS_READ_PERMISSION,
} from '../lib/settings-crypto.js';
import { PRIVATE_HUBJECT_URL_ERROR, validateHubjectUrl } from '../lib/hubject-url.js';
import { zodSchema } from '../lib/zod-schema.js';
import { successResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { config as apiConfig } from '../lib/config.js';
import { requireAllSiteAccess } from '../lib/site-access.js';

// Plug and Charge settings and the contract CA serve every site: company-wide,
// so a site-restricted user gets this 404 before any read or write
// (requireAllSiteAccess, features/site-access-control.md).
const ALL_SITES_SETTING_NOT_FOUND = {
  error: 'Setting not found',
  code: 'SETTING_NOT_FOUND',
} as const;

const testProviderResponse = z
  .object({ success: z.boolean().describe('Whether the provider connectivity test succeeded') })
  .loose();

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

// Checked in the handler (parseAllowedPrivateHosts): the JSON Schema conversion strips
// .refine(), .trim(), and .toLowerCase(), and Fastify validates the body with
// the JSON Schema only.
const ocspAllowedHost = z.string().max(253);

const updatePncSettingsBody = z.object({
  enabled: z.boolean().optional().describe('Enable or disable Plug and Charge'),
  provider: z
    .enum(['manual', 'hubject', 'local'])
    .optional()
    .describe('PKI provider type (local: the CSMS issues contract certificates from its own CA)'),
  hubjectBaseUrl: z
    .string()
    .optional()
    .describe(
      'Hubject OPCP API base URL. A change without hubjectClientSecret in the same request clears the stored client secret.',
    ),
  hubjectClientId: z.string().optional().describe('Hubject OAuth2 client ID'),
  hubjectClientSecret: z
    .string()
    .optional()
    .describe('Hubject OAuth2 client secret (stored encrypted)'),
  hubjectTokenUrl: z
    .string()
    .optional()
    .describe(
      'Hubject OAuth2 token endpoint URL. A change without hubjectClientSecret in the same request clears the stored client secret.',
    ),
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
        description:
          'Returns the stored pnc.* settings. pnc.hubject.clientSecretEnc is decrypted only when the caller also holds settings.system:read (for an API key, when its scope includes it), otherwise null; pnc.hubject.clientSecretConfigured says whether it is stored.',
        operationId: 'getPncSettings',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(z.record(z.string(), z.unknown())),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      // Push the PNC_KEYS filter to Postgres instead of selecting every
      // settings row and discarding the rest in JS.
      const rows = await db
        .select()
        .from(settings)
        .where(inArray(settings.key, [...PNC_KEYS]));
      // The Hubject client secret is returned decrypted only with
      // settings.system:read (P12), else null; pnc.hubject.clientSecretConfigured
      // says whether it is stored.
      return readSettingsWithSecrets(
        rows,
        await requestHasPermission(request, SECRET_SETTINGS_READ_PERMISSION),
      );
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
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const body = request.body as z.infer<typeof updatePncSettingsBody>;

      // Both Hubject URLs: the token URL receives the client secret.
      for (const url of [body.hubjectBaseUrl, body.hubjectTokenUrl]) {
        if (url !== undefined && validateHubjectUrl(url) == null) {
          await reply.status(400).send(PRIVATE_HUBJECT_URL_ERROR);
          return;
        }
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
      // A stored secret never follows a new endpoint:
      // the OCPP process posts the client secret to the token URL, so a caller
      // who may not read the secret could otherwise point a URL at its own host
      // and receive it. A URL change without a new secret clears the stored one.
      const newSecret = body.hubjectClientSecret !== undefined && body.hubjectClientSecret !== '';
      if (!newSecret && (body.hubjectBaseUrl !== undefined || body.hubjectTokenUrl !== undefined)) {
        const stored = await db
          .select()
          .from(settings)
          .where(
            inArray(settings.key, [
              'pnc.hubject.baseUrl',
              'pnc.hubject.tokenUrl',
              'pnc.hubject.clientSecretEnc',
            ]),
          );
        const storedUrl = (key: string): string => {
          const value = stored.find((row) => row.key === key)?.value;
          return typeof value === 'string' ? value : '';
        };
        const changed =
          (body.hubjectBaseUrl !== undefined &&
            body.hubjectBaseUrl !== storedUrl('pnc.hubject.baseUrl')) ||
          (body.hubjectTokenUrl !== undefined &&
            body.hubjectTokenUrl !== storedUrl('pnc.hubject.tokenUrl'));
        if (changed && storedUrl('pnc.hubject.clientSecretEnc') !== '') {
          updates.push({ key: 'pnc.hubject.clientSecretEnc', value: '' });
        }
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

      // One transaction, the secret first: a write that fails
      // or a process that stops part way never leaves a new URL next to the old
      // secret. The caches are cleared only after the commit.
      const ordered = [
        ...updates.filter((u) => u.key === 'pnc.hubject.clientSecretEnc'),
        ...updates.filter((u) => u.key !== 'pnc.hubject.clientSecretEnc'),
      ];
      await db.transaction(async (tx) => {
        for (const update of ordered) {
          await tx
            .insert(settings)
            .values({ key: update.key, value: update.value })
            .onConflictDoUpdate({
              target: settings.key,
              set: { value: update.value, updatedAt: new Date() },
            });
        }
      });

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
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
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

        // Attempt to reach the base URL as a connectivity check. A stored URL
        // saved before the check, or a name that resolves to an internal
        // address, is refused (validateHubjectUrl, then safeFetch).
        if (validateHubjectUrl(baseUrl) == null) {
          await reply.status(400).send(PRIVATE_HUBJECT_URL_ERROR);
          return;
        }
        const testUrl = `${baseUrl}/.well-known/est/cacerts`;
        const response = await safeFetch(testUrl, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        await response.body?.cancel();

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
