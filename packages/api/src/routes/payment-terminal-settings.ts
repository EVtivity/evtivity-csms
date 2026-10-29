// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Payment terminal provider settings (`/v1/settings/payment-terminals`,
// features/payment-terminals.md). Each operator holds its own merchant account
// at the gateway; the credentials are per-install `*Enc` settings (P12).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, like } from 'drizzle-orm';
import {
  db,
  parsePaymentTerminalSettings,
  settingAuditLog,
  settings,
  userPermissions,
  users,
  writeAudit,
} from '@evtivity/database';
import {
  encryptString,
  IDTECH_ENVIRONMENTS,
  isIdtechMerchantId,
  PAYMENT_TERMINAL_SETTING_KEYS as K,
} from '@evtivity/lib';
import { allowsUnverifiedTerminalAdapters } from '@evtivity/lib/payment-terminal-env';
import {
  IDTECH_LIVE_VERIFIED,
  idtechBuildAllowed,
  TerminalProviderError,
  TERMINAL_PROVIDER_IDS,
  type TerminalProviderId,
} from '@evtivity/payment-terminals';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse, successResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { requireAllSiteAccess } from '../lib/site-access.js';
import { SECRET_SETTINGS_READ_PERMISSION } from '../lib/settings-crypto.js';
import { factorProof } from '../lib/mfa-factor-proof.js';
import {
  isApiKeyRequest,
  requireSessionProof,
  SESSION_PROOF_ERROR_CODES,
  sessionProofErrorFields,
} from '../lib/session-proof.js';
import { sendSecurityNotice } from '../lib/security-notice.js';
import { clearTerminalCaches, terminalRegistry } from '../lib/payments.js';
import { config } from '../lib/config.js';

const ALL_SITES_SETTING_NOT_FOUND = {
  error: 'Setting not found',
  code: 'SETTING_NOT_FOUND',
} as const;

const settingsResponse = z
  .object({
    simulatedAvailable: z
      .boolean()
      .describe(
        'The simulated terminal provider exists in this API process (PAYMENT_TERMINALS_ALLOW_SIMULATED)',
      ),
    webhookPath: z.string().describe('Path of the ID TECH webhook route on this API'),
    idtech: z
      .object({
        enabled: z.boolean().describe('ID TECH PSG is on'),
        verified: z
          .boolean()
          .describe(
            'A recorded live sandbox run verified the ID TECH contract. While false the adapter runs only under NODE_ENV development or test.',
          ),
        environment: z.enum(IDTECH_ENVIRONMENTS).describe('PSG environment'),
        merchantId: z.string().describe('Merchant ID at the gateway, empty when unset'),
        apiKey: z
          .string()
          .nullable()
          .describe('API key, decrypted only for callers that also hold settings.system:read'),
        apiKeyConfigured: z.boolean().describe('An API key is stored'),
        apiSecret: z
          .string()
          .nullable()
          .describe('API secret, decrypted only for callers that also hold settings.system:read'),
        apiSecretConfigured: z.boolean().describe('An API secret is stored'),
        webhookSecret: z
          .string()
          .nullable()
          .describe('Webhook signing secret, decrypted only with settings.system:read'),
        webhookSecretConfigured: z.boolean().describe('A webhook signing secret is stored'),
      })
      .describe('ID TECH Payment Service Gateway account'),
  })
  .loose();

const updateBody = z.object({
  idtech: z
    .object({
      enabled: z.boolean().optional().describe('Turn ID TECH PSG on or off'),
      environment: z.enum(IDTECH_ENVIRONMENTS).optional().describe('sandbox or production'),
      merchantId: z.string().max(64).optional().describe('Merchant ID; an empty string clears it'),
      apiKey: z
        .string()
        .max(512)
        .optional()
        .describe('API key (stored encrypted); empty clears it'),
      apiSecret: z
        .string()
        .max(512)
        .optional()
        .describe('API secret (stored encrypted); empty clears it'),
      webhookSecret: z
        .string()
        .max(512)
        .optional()
        .describe('Webhook signing secret (stored encrypted); empty clears it'),
    })
    .optional()
    .describe('ID TECH account; an omitted field keeps its value'),
  proof: factorProof
    .optional()
    .describe(
      'Fresh proof of the account, required from a signed-in session when the environment, merchant or a credential changes',
    ),
});

const providerParams = z.object({
  provider: z
    .enum(TERMINAL_PROVIDER_IDS as [TerminalProviderId, ...TerminalProviderId[]])
    .describe('Terminal provider'),
});

/** The keys that point money at an account: an API key never changes them, a session proves itself. */
const ACCOUNT_KEYS: ReadonlySet<string> = new Set([
  K.idtechEnvironment,
  K.idtechMerchantId,
  K.idtechApiKeyEnc,
  K.idtechApiSecretEnc,
  K.idtechWebhookSecretEnc,
]);

const SECRET_KEYS: ReadonlySet<string> = new Set([
  K.idtechApiKeyEnc,
  K.idtechApiSecretEnc,
  K.idtechWebhookSecretEnc,
]);

async function readStored(): Promise<Map<string, unknown>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(like(settings.key, 'paymentTerminals.%'));
  return new Map(rows.map((r) => [r.key, r.value]));
}

function stored(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

async function paymentSettingsAdminIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(userPermissions, eq(userPermissions.userId, users.id))
    .where(
      and(
        eq(users.isActive, true),
        eq(users.hasAllSiteAccess, true),
        eq(userPermissions.permission, 'settings.payment:write'),
      ),
    );
  return rows.map((r) => r.id);
}

export function paymentTerminalSettingsRoutes(app: FastifyInstance): void {
  app.get(
    '/settings/payment-terminals',
    {
      onRequest: [authorize('settings.payment:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get payment terminal settings',
        description:
          'The terminal provider accounts. Secrets are returned decrypted only to callers that also hold settings.system:read; otherwise null with a Configured flag. Needs access to every site.',
        operationId: 'getPaymentTerminalSettings',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(settingsResponse),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const map = await readStored();
      const parsed = parsePaymentTerminalSettings(
        [...map].map(([key, value]) => ({ key, value })),
        config.SETTINGS_ENCRYPTION_KEY,
      );
      const secrets = await requestHasPermission(request, SECRET_SETTINGS_READ_PERMISSION);
      const reveal = (v: string): string | null => (secrets && v !== '' ? v : null);
      return {
        simulatedAvailable: config.PAYMENT_TERMINALS_ALLOW_SIMULATED,
        webhookPath: '/v1/webhooks/payment-terminals/idtech',
        idtech: {
          enabled: parsed.idtech.enabled,
          verified: IDTECH_LIVE_VERIFIED,
          environment: parsed.idtech.environment,
          merchantId: parsed.idtech.merchantId,
          apiKey: reveal(parsed.idtech.apiKey),
          apiKeyConfigured: stored(map.get(K.idtechApiKeyEnc)),
          apiSecret: reveal(parsed.idtech.apiSecret),
          apiSecretConfigured: stored(map.get(K.idtechApiSecretEnc)),
          webhookSecret: reveal(parsed.idtech.webhookSecret),
          webhookSecretConfigured: stored(map.get(K.idtechWebhookSecretEnc)),
        },
      };
    },
  );

  app.put(
    '/settings/payment-terminals',
    {
      onRequest: [authorize('settings.payment:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Update payment terminal settings',
        description:
          'Updates the given fields; an omitted field keeps its value. A change of the environment, the merchant or a credential needs a fresh proof from a signed-in session (an API key gets 403 SESSION_REQUIRED) and notifies the all-site users who may change payment settings. A stored secret never follows a changed environment: the secrets not sent with the change are cleared. ID TECH can be turned on only where the contract is verified or under NODE_ENV development or test (400 PAYMENT_TERMINAL_PROVIDER_UNVERIFIED).',
        operationId: 'updatePaymentTerminalSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateBody),
        response: {
          200: successResponse,
          400: errorWith(
            'Validation error, unverified provider, or a missing or wrong proof',
            [...SESSION_PROOF_ERROR_CODES, ERROR_CODES.PAYMENT_TERMINAL_PROVIDER_UNVERIFIED],
            sessionProofErrorFields,
          ),
          403: errorWith('API key changing the account', [ERROR_CODES.SESSION_REQUIRED]),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
          500: errorWith('Encryption key missing', [ERROR_CODES.ENCRYPTION_KEY_MISSING]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const body = request.body as z.infer<typeof updateBody>;
      const idtech = body.idtech ?? {};
      const merchantId = idtech.merchantId?.trim();
      if (merchantId !== undefined && merchantId !== '' && !isIdtechMerchantId(merchantId)) {
        return reply.status(400).send({
          error: 'The merchant ID holds 1 to 64 letters, digits, _ or -',
          code: 'VALIDATION_ERROR',
        });
      }
      if (
        idtech.enabled === true &&
        !idtechBuildAllowed(allowsUnverifiedTerminalAdapters(process.env))
      ) {
        return reply.status(400).send({
          error:
            'The ID TECH integration is not verified for production use yet: it can be turned on only in development and test',
          code: 'PAYMENT_TERMINAL_PROVIDER_UNVERIFIED',
        });
      }
      const key = config.SETTINGS_ENCRYPTION_KEY;
      if (key === '') {
        return reply.status(500).send({
          error: 'SETTINGS_ENCRYPTION_KEY not configured',
          code: 'ENCRYPTION_KEY_MISSING',
        });
      }
      const before = await readStored();
      const parsed = parsePaymentTerminalSettings(
        [...before].map(([k, v]) => ({ key: k, value: v })),
        key,
      );
      const pairs: Array<{ key: string; value: unknown }> = [];
      const secretChange = (
        settingKey: string,
        sent: string | undefined,
        current: string,
      ): void => {
        const value = sent?.trim();
        if (value === undefined || value === current) return;
        pairs.push({ key: settingKey, value: value === '' ? '' : encryptString(value, key) });
      };
      const environmentChanged =
        idtech.environment !== undefined && idtech.environment !== parsed.idtech.environment;
      // A stored secret never follows a changed environment (security case 179):
      // a secret not sent with the change is cleared, written first (case 196).
      if (environmentChanged) {
        if (idtech.apiKey === undefined && parsed.idtech.apiKey !== '') {
          pairs.push({ key: K.idtechApiKeyEnc, value: '' });
        }
        if (idtech.apiSecret === undefined && parsed.idtech.apiSecret !== '') {
          pairs.push({ key: K.idtechApiSecretEnc, value: '' });
        }
        if (idtech.webhookSecret === undefined && parsed.idtech.webhookSecret !== '') {
          pairs.push({ key: K.idtechWebhookSecretEnc, value: '' });
        }
      }
      secretChange(K.idtechApiKeyEnc, idtech.apiKey, parsed.idtech.apiKey);
      secretChange(K.idtechApiSecretEnc, idtech.apiSecret, parsed.idtech.apiSecret);
      secretChange(K.idtechWebhookSecretEnc, idtech.webhookSecret, parsed.idtech.webhookSecret);
      if (environmentChanged) pairs.push({ key: K.idtechEnvironment, value: idtech.environment });
      if (merchantId !== undefined && merchantId !== parsed.idtech.merchantId) {
        pairs.push({ key: K.idtechMerchantId, value: merchantId });
      }
      if (idtech.enabled !== undefined && idtech.enabled !== parsed.idtech.enabled) {
        pairs.push({ key: K.idtechEnabled, value: idtech.enabled });
      }
      const accountChanged = pairs.some((p) => ACCOUNT_KEYS.has(p.key));
      if (accountChanged && isApiKeyRequest(request)) {
        return reply.status(403).send({
          error: 'The terminal account changes only from a signed-in session',
          code: 'SESSION_REQUIRED',
        });
      }
      if (accountChanged && !(await requireSessionProof(request, reply, body.proof))) return;
      if (pairs.length > 0) {
        await db.transaction(async (tx) => {
          for (const { key: settingKey, value } of pairs) {
            await tx
              .insert(settings)
              .values({ key: settingKey, value })
              .onConflictDoUpdate({
                target: settings.key,
                set: { value, updatedAt: new Date() },
              });
          }
        });
      }
      clearTerminalCaches();
      const actor = getAuditActor(request);
      await Promise.allSettled(
        pairs.map(({ key: settingKey, value }) =>
          writeAudit(
            { table: settingAuditLog, idColumn: 'setting_key' },
            {
              entityId: settingKey,
              entityIdSnapshot: settingKey,
              action: 'updated',
              ...actor,
              before: SECRET_KEYS.has(settingKey)
                ? { key: settingKey, configured: stored(before.get(settingKey)) }
                : { key: settingKey, value: before.get(settingKey) ?? null },
              after: SECRET_KEYS.has(settingKey)
                ? { key: settingKey, configured: value !== '' }
                : { key: settingKey, value },
            },
            db,
            request.log,
          ),
        ),
      );
      if (accountChanged || pairs.some((p) => p.key === K.idtechEnabled)) {
        void paymentSettingsAdminIds()
          .then((ids) => {
            for (const userId of ids) {
              sendSecurityNotice(
                { userId },
                'security.PaymentTerminalSettingsChanged',
                {
                  provider: 'ID TECH',
                  accountChanged,
                  enabled: idtech.enabled ?? parsed.idtech.enabled,
                },
                request.log,
              );
            }
          })
          .catch((err: unknown) => {
            request.log.warn(
              { err },
              'Terminal settings notice recipients failed, the change stands',
            );
          });
      }
      return { success: true };
    },
  );

  app.post(
    '/settings/payment-terminals/:provider/test',
    {
      onRequest: [authorize('settings.payment:write')],
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
      schema: {
        tags: ['Settings'],
        summary: 'Test a payment terminal provider connection',
        description:
          'Checks the stored credentials of the provider. The provider must be on and have credentials. 6 a minute.',
        operationId: 'testPaymentTerminalProvider',
        security: [{ bearerAuth: [] }],
        params: zodSchema(providerParams),
        response: {
          200: itemResponse(
            z
              .object({
                ok: z.boolean().describe('The provider accepted the credentials'),
                reason: z.string().optional().describe('Why not (an error kind)'),
              })
              .loose(),
          ),
          400: errorWith('Provider not configured', [
            ERROR_CODES.PAYMENT_TERMINAL_PROVIDER_NOT_CONFIGURED,
          ]),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const { provider: providerId } = request.params as z.infer<typeof providerParams>;
      const provider = await terminalRegistry.getProvider(providerId);
      if (provider == null) {
        return reply.status(400).send({
          error: 'The payment terminal provider is off or has no credentials',
          code: 'PAYMENT_TERMINAL_PROVIDER_NOT_CONFIGURED',
        });
      }
      try {
        return await provider.testConnection();
      } catch (err: unknown) {
        if (err instanceof TerminalProviderError) return { ok: false, reason: err.kind };
        throw err;
      }
    },
  );
}
