// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { like } from 'drizzle-orm';
import { db, parseSimSettings, settingAuditLog, settings, writeAudit } from '@evtivity/database';
import {
  createLogger,
  encryptString,
  isSimSignalDbm,
  ValidationError,
  parseOcpp16SignalKeys,
  SIM_FETCH_DAYS,
  SIM_OCPP16_SIGNAL_KEYS_LIMITS,
  SIM_RETENTION_DAYS,
  SIM_HOLOGRAM_ORG_ID_MAX_DIGITS,
  SIM_SETTING_KEYS,
  SIM_SIGNAL_DBM,
  isHologramOrgId,
} from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { scheduleLowSignalSync } from '@evtivity/services/station-signal-monitor.service';
import {
  SIM_DEFAULT_BACKOFF_SECONDS,
  SIM_KEYS,
  SIM_PROVIDER_ORDER,
  SimProviderError,
  type SimProviderId,
} from '@evtivity/services/station-sim.service';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { rejectUnknownBodyKeys, zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse, successResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { requireAllSiteAccess } from '../lib/site-access.js';
import { isEncryptedAtRest, SECRET_SETTINGS_READ_PERMISSION } from '../lib/settings-crypto.js';
import {
  clearSimCaches,
  readSimSettings,
  simEncryptionKey,
  simProviderRegistry,
} from '../lib/sim.js';
import { simKeyStore } from '../lib/sim-keys.js';

const logger = createLogger('sim-provider-settings');

// SIM provider credentials serve every site: a site-restricted user gets this
// 404 before any read or write.
const ALL_SITES_SETTING_NOT_FOUND = {
  error: 'Setting not found',
  code: 'SETTING_NOT_FOUND',
} as const;

const dbm = z.number().int().min(SIM_SIGNAL_DBM.min).max(SIM_SIGNAL_DBM.max);

const simProviderSettingsResponse = z
  .object({
    hologram: z
      .object({
        enabled: z.boolean().describe('Hologram is on'),
        orgId: z.string().describe('Hologram organization id (digits), empty when unset'),
        apiKey: z
          .string()
          .nullable()
          .describe(
            'Hologram API key, decrypted. Returned only to callers that also hold settings.system:read; null otherwise and when unset (see apiKeyConfigured).',
          ),
        apiKeyConfigured: z.boolean().describe('A Hologram API key is stored'),
      })
      .describe('Hologram account'),
    retentionDays: z.number().describe('Days fetched SIM sessions and alerts are kept'),
    fetchDays: z.number().describe('Refresh period preselected on the Connectivity tab, in days'),
    stationSignalEnabled: z
      .boolean()
      .describe('Refresh also reads the signal values from the station over OCPP'),
    signalAlertBelowDbm: z
      .number()
      .nullable()
      .describe('Low signal alert threshold in dBm, null when off'),
    ocpp16SignalKeys: z
      .array(z.string())
      .describe('OCPP 1.6 configuration keys read for the station signal'),
    signalGoodDbm: z.number().describe('At or above this dBm the signal is good'),
    signalFairDbm: z.number().describe('At or above this dBm the signal is fair, below it poor'),
  })
  .describe(
    'SIM provider and station signal settings. The API key is returned decrypted only to callers that also hold settings.system:read.',
  );

const updateSimProviderSettingsBody = z.object({
  hologram: z
    .object({
      enabled: z.boolean().optional().describe('Turn Hologram on or off'),
      orgId: z
        .string()
        .max(SIM_HOLOGRAM_ORG_ID_MAX_DIGITS)
        .optional()
        .describe('Hologram organization id (1 to 15 digits). An empty string clears it.'),
      apiKey: z
        .string()
        .max(512)
        .optional()
        .describe('Hologram API key (stored encrypted). An empty string clears it.'),
    })
    .optional()
    .describe('Hologram account; an omitted field keeps its value'),
  retentionDays: z
    .number()
    .int()
    .min(SIM_RETENTION_DAYS.min)
    .max(SIM_RETENTION_DAYS.max)
    .optional()
    .describe('Days fetched SIM sessions and alerts are kept (7 to 730)'),
  fetchDays: z
    .number()
    .int()
    .min(SIM_FETCH_DAYS.min)
    .max(SIM_FETCH_DAYS.max)
    .optional()
    .describe('Refresh period preselected on the Connectivity tab, in days (1 to 31)'),
  stationSignalEnabled: z
    .boolean()
    .optional()
    .describe('Refresh also reads the signal from the station (one OCPP request per Refresh)'),
  signalAlertBelowDbm: dbm
    .nullable()
    .optional()
    .describe('Low signal alert threshold in dBm (-140 to -40); null turns it off'),
  ocpp16SignalKeys: z
    .array(z.string().max(SIM_OCPP16_SIGNAL_KEYS_LIMITS.maxLength))
    .max(SIM_OCPP16_SIGNAL_KEYS_LIMITS.maxKeys)
    .optional()
    .describe('OCPP 1.6 configuration keys read for the station signal'),
  signalGoodDbm: dbm.optional().describe('Good signal threshold in dBm, above the fair one'),
  signalFairDbm: dbm.optional().describe('Fair signal threshold in dBm, below the good one'),
});

const HOLOGRAM_BODY_KEYS: ReadonlySet<string> = new Set(['enabled', 'orgId', 'apiKey']);

/** A misspelled Hologram field would be dropped silently and answer 200. */
function rejectUnknownHologramKeys(request: FastifyRequest): Promise<void> {
  const hologram = (request.body as { hologram?: unknown } | null)?.hologram;
  if (hologram == null || typeof hologram !== 'object' || Array.isArray(hologram)) {
    return Promise.resolve();
  }
  const unknown = Object.keys(hologram).filter((key) => !HOLOGRAM_BODY_KEYS.has(key));
  const first = unknown[0];
  if (first == null) return Promise.resolve();
  return Promise.reject(
    new ValidationError(
      `Unknown field hologram.${first}`,
      unknown.map((key) => ({ path: ['hologram', key], message: 'Unknown field' })),
    ),
  );
}

const providerParams = z.object({
  provider: z
    .enum(SIM_PROVIDER_ORDER as [SimProviderId, ...SimProviderId[]])
    .describe('SIM provider'),
});

const testConnectionResponse = z
  .object({
    provider: z.string().describe('SIM provider tested'),
    deviceCount: z.number().describe('SIMs in the stored organization'),
    otherOrganizations: z
      .array(
        z
          .object({
            id: z.string().describe('Organization id'),
            name: z.string().describe('Organization name'),
            deviceCount: z.number().describe('SIMs in that organization'),
          })
          .passthrough(),
      )
      .describe('Other organizations the API key reaches (at most 10), with their SIM counts'),
  })
  .passthrough();

async function readStoredSimSettings(): Promise<Map<string, unknown>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(like(settings.key, 'sim.%'));
  return new Map(rows.map((row) => [row.key, row.value]));
}

const PROVIDER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  auth: 'The SIM provider refused the API key',
  not_found: 'The SIM provider does not know the organization',
  unsupported: 'The SIM provider refused the request',
  unavailable: 'The SIM provider did not answer',
};

/** Answers a SIM provider error: 429 with Retry-After for a rate limit, else 502. */
export async function sendSimProviderError(
  err: SimProviderError,
  reply: FastifyReply,
): Promise<void> {
  if (err.kind === 'rate_limited') {
    const retryAfter = err.retryAfterSeconds ?? 60;
    await reply.status(429).header('Retry-After', String(retryAfter)).send({
      error: 'Too many SIM requests, try again later',
      code: 'SIM_PROVIDER_RATE_LIMITED',
      retryAfter,
    });
    return;
  }
  await reply.status(502).send({
    error: PROVIDER_ERROR_MESSAGES[err.kind] ?? 'The SIM provider request failed',
    code: 'SIM_PROVIDER_ERROR',
    kind: err.kind,
  });
}

/** Connection tests per provider a minute, across API pods. */
export const SIM_TEST_LIMIT_PER_MINUTE = 6;

export function simProviderSettingsRoutes(app: FastifyInstance): void {
  app.get(
    '/settings/sim-providers',
    {
      onRequest: [authorize('settings.integrations:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get SIM provider settings',
        description:
          'Returns the SIM provider account and the station signal settings. The API key is returned decrypted only when the caller also holds settings.system:read; otherwise it is null and apiKeyConfigured says whether one is stored.',
        operationId: 'getSimProviderSettings',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(simProviderSettingsResponse),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const stored = await readStoredSimSettings();
      const parsed = parseSimSettings(
        [...stored].map(([key, value]) => ({ key, value })),
        simEncryptionKey(),
      );
      const includeSecrets = await requestHasPermission(request, SECRET_SETTINGS_READ_PERMISSION);
      const storedKey = stored.get(SIM_SETTING_KEYS.hologramApiKeyEnc);
      return {
        hologram: {
          enabled: parsed.hologram.enabled,
          orgId: parsed.hologram.orgId,
          apiKey: includeSecrets && parsed.hologram.apiKey !== '' ? parsed.hologram.apiKey : null,
          apiKeyConfigured: typeof storedKey === 'string' && storedKey !== '',
        },
        retentionDays: parsed.retentionDays,
        fetchDays: parsed.fetchDays,
        stationSignalEnabled: parsed.stationSignalEnabled,
        signalAlertBelowDbm: parsed.signalAlertBelowDbm,
        ocpp16SignalKeys: parsed.ocpp16SignalKeys,
        signalGoodDbm: parsed.signalGoodDbm,
        signalFairDbm: parsed.signalFairDbm,
      };
    },
  );

  app.put(
    '/settings/sim-providers',
    {
      onRequest: [authorize('settings.integrations:write')],
      preValidation: [
        rejectUnknownBodyKeys(updateSimProviderSettingsBody),
        rejectUnknownHologramKeys,
      ],
      schema: {
        tags: ['Settings'],
        summary: 'Update SIM provider settings',
        description:
          'Updates the given SIM provider and station signal settings; an omitted field keeps its value. The API key is stored encrypted and an empty string clears it. The organization id holds digits only. The good signal threshold must stay above the fair one.',
        operationId: 'updateSimProviderSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateSimProviderSettingsBody),
        response: {
          200: successResponse,
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const body = request.body as z.infer<typeof updateSimProviderSettingsBody>;

      const orgId = body.hologram?.orgId?.trim();
      if (orgId !== undefined && orgId !== '' && !isHologramOrgId(orgId)) {
        await reply.status(400).send({
          error: 'The Hologram organization id holds 1 to 15 digits',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      const signalKeys =
        body.ocpp16SignalKeys !== undefined
          ? parseOcpp16SignalKeys(body.ocpp16SignalKeys)
          : undefined;
      if (signalKeys === null) {
        await reply.status(400).send({
          error: 'The OCPP 1.6 signal keys are not valid',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const stored = await readStoredSimSettings();
      const parsed = parseSimSettings(
        [...stored].map(([key, value]) => ({ key, value })),
        simEncryptionKey(),
      );
      const good = body.signalGoodDbm ?? parsed.signalGoodDbm;
      const fair = body.signalFairDbm ?? parsed.signalFairDbm;
      if (!isSimSignalDbm(good) || !isSimSignalDbm(fair) || good <= fair) {
        await reply.status(400).send({
          error: 'The good signal threshold must be above the fair one',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const pairs: Array<{ key: string; value: unknown }> = [];
      if (body.hologram?.enabled !== undefined) {
        pairs.push({ key: SIM_SETTING_KEYS.hologramEnabled, value: body.hologram.enabled });
      }
      if (orgId !== undefined) pairs.push({ key: SIM_SETTING_KEYS.hologramOrgId, value: orgId });
      const apiKey = body.hologram?.apiKey?.trim();
      // The stored key sent again changes nothing: no write and no audit row.
      if (apiKey !== undefined && apiKey !== parsed.hologram.apiKey) {
        pairs.push({
          key: SIM_SETTING_KEYS.hologramApiKeyEnc,
          value: apiKey === '' ? '' : encryptString(apiKey, simEncryptionKey()),
        });
      }
      if (body.retentionDays !== undefined) {
        pairs.push({ key: SIM_SETTING_KEYS.retentionDays, value: body.retentionDays });
      }
      if (body.fetchDays !== undefined) {
        pairs.push({ key: SIM_SETTING_KEYS.fetchDays, value: body.fetchDays });
      }
      if (body.stationSignalEnabled !== undefined) {
        pairs.push({
          key: SIM_SETTING_KEYS.stationSignalEnabled,
          value: body.stationSignalEnabled,
        });
      }
      if (body.signalAlertBelowDbm !== undefined) {
        pairs.push({
          key: SIM_SETTING_KEYS.signalAlertBelowDbm,
          value: body.signalAlertBelowDbm ?? '',
        });
      }
      if (signalKeys !== undefined) {
        pairs.push({ key: SIM_SETTING_KEYS.ocpp16SignalKeys, value: signalKeys });
      }
      if (body.signalGoodDbm !== undefined) {
        pairs.push({ key: SIM_SETTING_KEYS.signalGoodDbm, value: body.signalGoodDbm });
      }
      if (body.signalFairDbm !== undefined) {
        pairs.push({ key: SIM_SETTING_KEYS.signalFairDbm, value: body.signalFairDbm });
      }

      if (pairs.length > 0) {
        await db.transaction(async (tx) => {
          for (const { key, value } of pairs) {
            await tx
              .insert(settings)
              .values({ key, value })
              .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
          }
        });
      }
      clearSimCaches();
      // The OCPP pods read the signal settings at every boot: they drop their
      // cache now instead of after its 60 s.
      try {
        await getPubSub().publish('cache_invalidate', JSON.stringify({ kind: 'sim_settings' }));
      } catch (err: unknown) {
        request.log.warn(
          { err },
          'SIM settings invalidation publish failed, peers refresh within 60s',
        );
      }

      // The low signal monitors follow the switch and the threshold: set on the
      // online stations that can monitor their signal, cleared when turned off.
      const signalChanged =
        (body.stationSignalEnabled !== undefined &&
          body.stationSignalEnabled !== parsed.stationSignalEnabled) ||
        (body.signalAlertBelowDbm !== undefined &&
          (body.signalAlertBelowDbm ?? null) !== parsed.signalAlertBelowDbm);

      // A secret is audited as changed, never with its ciphertext.
      const auditValue = (key: string, value: unknown): unknown =>
        isEncryptedAtRest(key) && value !== '' && value != null ? '<redacted>' : value;
      const actor = getAuditActor(request);
      await Promise.allSettled(
        pairs
          .filter(({ key, value }) => JSON.stringify(stored.get(key)) !== JSON.stringify(value))
          .map(({ key, value }) =>
            writeAudit(
              { table: settingAuditLog, idColumn: 'setting_key' },
              {
                entityId: key,
                entityIdSnapshot: key,
                action: 'updated',
                ...actor,
                before: { key, value: auditValue(key, stored.get(key)) },
                after: { key, value: auditValue(key, value) },
              },
              db,
              request.log,
            ),
          ),
      );
      // Runs after the reply, in batches, one run per process at a time.
      if (signalChanged) {
        setImmediate(() => {
          void scheduleLowSignalSync(readSimSettings, { pubsub: getPubSub(), log: logger });
        });
      }
      return { success: true };
    },
  );

  app.post(
    '/settings/sim-providers/:provider/test',
    {
      onRequest: [authorize('settings.integrations:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Test a SIM provider connection',
        description:
          'Checks the stored credentials of the provider: the SIM count of the stored organization and of up to 10 other organizations the API key reaches. The provider must be on and have credentials.',
        operationId: 'testSimProviderConnection',
        security: [{ bearerAuth: [] }],
        params: zodSchema(providerParams),
        response: {
          200: itemResponse(testConnectionResponse),
          400: errorWith('Provider not configured', [ERROR_CODES.SIM_PROVIDER_NOT_CONFIGURED]),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
          429: errorWith('Rate limited by the provider', [ERROR_CODES.SIM_PROVIDER_RATE_LIMITED]),
          502: errorWith('Provider request failed', [ERROR_CODES.SIM_PROVIDER_ERROR]),
          503: errorWith('Provider backoff not checked', [ERROR_CODES.SIM_TEST_UNAVAILABLE]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const { provider: providerId } = request.params as z.infer<typeof providerParams>;
      const provider = await simProviderRegistry().getProvider(providerId);
      if (provider == null) {
        await reply.status(400).send({
          error: 'The SIM provider is off or has no credentials',
          code: 'SIM_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
      const keys = simKeyStore();
      // A limit of its own, so a person cannot spend the provider's rate limit on tests.
      let count: number | null = null;
      try {
        count = await keys.increment(SIM_KEYS.test(providerId), 60);
      } catch (err: unknown) {
        request.log.warn(
          { err, provider: providerId },
          'SIM connection test limit not counted in Redis; the test runs',
        );
      }
      if (count != null && count > SIM_TEST_LIMIT_PER_MINUTE) {
        let retryAfter = 60;
        try {
          retryAfter = (await keys.ttlSeconds(SIM_KEYS.test(providerId))) ?? 60;
        } catch (err: unknown) {
          request.log.warn({ err, provider: providerId }, 'SIM test limit wait not read in Redis');
        }
        await reply.status(429).header('Retry-After', String(retryAfter)).send({
          error: 'Too many connection tests, try again later',
          code: 'SIM_PROVIDER_RATE_LIMITED',
          retryAfter,
        });
        return;
      }
      const backoffKey = SIM_KEYS.backoff(providerId);
      let waiting: number | null;
      try {
        waiting = await keys.ttlSeconds(backoffKey);
      } catch (err: unknown) {
        // As Refresh: without the backoff a test could call a provider that asked to wait.
        request.log.warn(
          { err, provider: providerId },
          'SIM provider backoff not read from Redis; no provider call',
        );
        await reply.status(503).send({
          error: 'The connection test cannot run right now, try again in a minute',
          code: 'SIM_TEST_UNAVAILABLE',
        });
        return;
      }
      if (waiting != null) {
        await reply.status(429).header('Retry-After', String(waiting)).send({
          error: 'The SIM provider asked to wait, try again later',
          code: 'SIM_PROVIDER_RATE_LIMITED',
          retryAfter: waiting,
        });
        return;
      }
      try {
        const result = await provider.testConnection();
        return { provider: providerId, ...result };
      } catch (err: unknown) {
        if (!(err instanceof SimProviderError)) throw err;
        request.log.warn({ err, provider: providerId }, 'SIM provider connection test failed');
        if (err.kind === 'rate_limited') {
          try {
            await keys.setFor(backoffKey, err.retryAfterSeconds ?? SIM_DEFAULT_BACKOFF_SECONDS);
          } catch (setErr: unknown) {
            request.log.warn(
              { err: setErr, provider: providerId },
              'SIM provider backoff not stored in Redis',
            );
          }
        }
        await sendSimProviderError(err, reply);
        return;
      }
    },
  );
}
