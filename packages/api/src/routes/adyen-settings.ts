// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { like } from 'drizzle-orm';
import { db, settings } from '@evtivity/database';
import { encryptString } from '@evtivity/lib';
import {
  ADYEN_LIVE_REGIONS,
  ADYEN_LIVE_URL_PREFIX_PATTERN,
  ADYEN_WEBHOOK_EVENT_CODES,
  AdyenApiError,
  AdyenPaymentProvider,
  hasAdyenWebhookRole,
  PaymentProviderNotConfiguredError,
  PaymentProviderPermissionError,
  PaymentProviderUnavailableError,
  WebhookExistsError,
} from '@evtivity/payments';
import type { AdyenCredentialInfo, WebhookEndpointInfo } from '@evtivity/payments';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse, successResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { config } from '../lib/config.js';
import { paymentRegistry } from '../lib/payments.js';
import { writePaymentSettings } from '../lib/payment-settings-writes.js';
import {
  checkPaymentWebhookLookupUrl,
  checkPaymentWebhookUrl,
  splitWebhookEndpoints,
} from '../lib/payment-webhook-url.js';
import { decryptForRead, SECRET_SETTINGS_READ_PERMISSION } from '../lib/settings-crypto.js';

/** The path Adyen posts to; the operator's webhook URL must end in it exactly. */
export const ADYEN_WEBHOOK_URL_PATH = '/v1/webhooks/payments/adyen';

const adyenSettingsResponse = z
  .object({
    merchantAccount: z.string().nullable().describe('Adyen merchant account code'),
    environment: z.enum(['test', 'live']).describe('Adyen environment'),
    liveUrlPrefix: z
      .string()
      .nullable()
      .describe('Live URL prefix (Customer Area > Developers > API URLs), required when live'),
    liveRegion: z.enum(ADYEN_LIVE_REGIONS).describe('Live region of the client SDKs'),
    clientKey: z
      .string()
      .nullable()
      .describe('Public client key for the browser and mobile SDKs (not a secret)'),
    webhookUsername: z
      .string()
      .nullable()
      .describe('Basic auth username Adyen sends with each webhook'),
    authorisationAdjustment: z
      .boolean()
      .describe('Raise holds with an authorization adjustment instead of a top-up charge'),
    apiKey: z
      .string()
      .nullable()
      .describe(
        'Adyen API key, decrypted. Returned only to callers that also hold settings.system:read; null otherwise and when unset (see apiKeyConfigured).',
      ),
    apiKeyConfigured: z.boolean().describe('An Adyen API key is stored'),
    hmacKey: z
      .string()
      .nullable()
      .describe(
        'Webhook HMAC key in hex, decrypted. Returned only to callers that also hold settings.system:read; null otherwise and when unset (see hmacKeyConfigured).',
      ),
    hmacKeyConfigured: z.boolean().describe('A webhook HMAC key is stored'),
    hmacKeyPreviousConfigured: z
      .boolean()
      .describe('A previous HMAC key is stored and still accepted (key rotation)'),
    webhookPassword: z
      .string()
      .nullable()
      .describe(
        'Webhook Basic auth password, decrypted. Returned only to callers that also hold settings.system:read; null otherwise and when unset (see webhookPasswordConfigured).',
      ),
    webhookPasswordConfigured: z.boolean().describe('A webhook Basic auth password is stored'),
    webhookUrlPath: z
      .literal(ADYEN_WEBHOOK_URL_PATH)
      .describe('Path of the Adyen webhook on this API; prefix it with the public API URL'),
  })
  .describe(
    'Adyen settings. The secrets are returned decrypted only to callers that also hold settings.system:read; every caller gets whether each one is stored. The previous HMAC key is reported only as stored or not.',
  );

const updateAdyenSettingsBody = z.object({
  apiKey: z
    .string()
    .optional()
    .describe('Adyen API key (stored encrypted). An empty string clears it.'),
  merchantAccount: z.string().min(1).optional().describe('Adyen merchant account code'),
  clientKey: z.string().optional().describe('Public client key. An empty string clears it.'),
  environment: z.enum(['test', 'live']).optional().describe('Adyen environment'),
  liveUrlPrefix: z
    .union([z.literal(''), z.string().regex(ADYEN_LIVE_URL_PREFIX_PATTERN)])
    .optional()
    .describe(
      'Live URL prefix, for example 1797a841fbb37ca7-AdyenDemo. Required when the environment is live. An empty string clears it.',
    ),
  liveRegion: z.enum(ADYEN_LIVE_REGIONS).optional().describe('Live region of the client SDKs'),
  hmacKey: z
    .union([z.literal(''), z.string().regex(/^[0-9A-Fa-f]+$/)])
    .optional()
    .describe('Webhook HMAC key in hex (stored encrypted). Empty clears it.'),
  webhookUsername: z
    .string()
    .optional()
    .describe('Webhook Basic auth username. An empty string clears it.'),
  webhookPassword: z
    .string()
    .optional()
    .describe('Webhook Basic auth password (stored encrypted). Empty clears it.'),
  authorisationAdjustment: z
    .boolean()
    .optional()
    .describe('Raise holds with an authorization adjustment instead of a top-up charge'),
});

const adyenTestResponse = z
  .object({
    success: z.literal(true),
    roles: z.array(z.string()).describe('Roles of the API credential (Management API /me)'),
    webhookRoleGranted: z
      .boolean()
      .describe('The credential has "Management API - Webhooks read and write"'),
  })
  .describe('Adyen connection test result');

const webhookEndpointSchema = z
  .object({
    id: z.string().describe('Adyen webhook ID'),
    url: z.string().describe('URL Adyen sends events to'),
    scope: z.string().describe('Webhook type (standard)'),
    enabledEvents: z.array(z.string()).describe('Event codes the webhook sends'),
    apiVersion: z.string().nullable().describe('Always null for Adyen'),
    active: z.boolean().describe('Adyen sends events to this webhook'),
  })
  .passthrough()
  .describe('An EVtivity webhook on the Adyen merchant account');

const otherWebhookEndpoints = z
  .array(webhookEndpointSchema)
  .describe(
    'EVtivity webhooks of other deployments sharing the merchant account (another URL). Creating or updating the webhook never changes them.',
  );

const adyenWebhookResponse = z
  .object({
    endpoints: z
      .array(webhookEndpointSchema)
      .describe('EVtivity webhooks at the url query (every EVtivity webhook without url)'),
    otherEndpoints: otherWebhookEndpoints,
    hmacKeyConfigured: z.boolean().describe('A webhook HMAC key is stored'),
    webhookPasswordConfigured: z.boolean().describe('A webhook Basic auth password is stored'),
    events: z.array(z.string()).describe('Event codes EVtivity enables on its webhook'),
  })
  .describe('The EVtivity webhook on the Adyen merchant account');

const createAdyenWebhookBody = z.object({
  url: z
    .string()
    .min(1)
    .describe(`Public https URL of this API's Adyen webhook, ending in ${ADYEN_WEBHOOK_URL_PATH}`),
  replace: z
    .boolean()
    .default(false)
    .describe(
      'Update the existing webhook at this URL with new credentials and a new HMAC key. Webhooks of other EVtivity deployments at other URLs are never changed.',
    ),
});

const adyenWebhookQuery = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      `Webhook URL of this deployment (http or https, ending in ${ADYEN_WEBHOOK_URL_PATH}). Splits the EVtivity webhooks into the one at this URL and the ones of other deployments.`,
    ),
});

const adyenWebhookExistsResponse = z
  .object({
    error: z.string().describe('Default: "An EVtivity webhook already exists for adyen"'),
    code: z.literal('PAYMENT_WEBHOOK_EXISTS').describe('Error code returned at this status'),
    endpoints: z
      .array(webhookEndpointSchema)
      .describe('The webhooks at the requested URL; send replace: true to update it'),
    otherEndpoints: otherWebhookEndpoints,
  })
  .passthrough()
  .describe('A webhook already exists at this URL');

const createAdyenWebhookResponse = z
  .object({
    endpoints: z.array(webhookEndpointSchema),
    test: z
      .object({
        status: z.string().describe('Result of the Adyen test delivery (success or failed)'),
        responseCode: z.string().nullable().describe('HTTP status this API answered Adyen with'),
      })
      .describe('Test AUTHORISATION event Adyen sent to the webhook'),
  })
  .describe('The created or updated Adyen webhook');

function configured(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

function plainString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The plaintext of an `*Enc` setting, decrypted like the generic settings GET (P12). */
function decryptedSecret(map: Map<string, unknown>, key: string): string | null {
  const value = decryptForRead(key, map.get(key));
  return typeof value === 'string' && value !== '' ? value : null;
}

function encryptionKey(): string {
  const key = config.SETTINGS_ENCRYPTION_KEY;
  if (key === '') throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  return key;
}

async function readAdyenSettings(): Promise<Map<string, unknown>> {
  const rows = await db.select().from(settings).where(like(settings.key, 'adyen.%'));
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** The configured Adyen provider; throws PaymentProviderNotConfiguredError without credentials. */
async function adyenProvider(): Promise<AdyenPaymentProvider> {
  const provider = await paymentRegistry.getPaymentProvider('adyen');
  if (!(provider instanceof AdyenPaymentProvider)) {
    throw new PaymentProviderNotConfiguredError('adyen');
  }
  return provider;
}

/** Answers the provider errors these routes expect; returns false for any other error. */
async function sendProviderError(err: unknown, reply: FastifyReply): Promise<boolean> {
  if (err instanceof PaymentProviderNotConfiguredError) {
    await reply.status(400).send({
      error: 'Adyen is not configured',
      code: ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
    });
    return true;
  }
  if (err instanceof PaymentProviderPermissionError) {
    await reply.status(400).send({
      error: err.message,
      code: ERROR_CODES.PAYMENT_PROVIDER_PERMISSION_MISSING,
      permission: err.permission,
    });
    return true;
  }
  if (err instanceof WebhookExistsError) {
    await reply.status(409).send({
      error: err.message,
      code: ERROR_CODES.PAYMENT_WEBHOOK_EXISTS,
      endpoints: err.endpoints,
      otherEndpoints: err.otherEndpoints,
    });
    return true;
  }
  if (err instanceof AdyenApiError || err instanceof PaymentProviderUnavailableError) {
    await reply.status(400).send({
      error: err.message,
      code: ERROR_CODES.PAYMENT_PROVIDER_CONNECTION_FAILED,
    });
    return true;
  }
  return false;
}

export function adyenSettingsRoutes(app: FastifyInstance): void {
  app.get(
    '/settings/adyen',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'Get Adyen settings',
        description:
          'Returns the Adyen settings and whether each secret is stored. The API key, HMAC key and webhook password are returned decrypted only when the caller also holds settings.system:read (for an API key, when its scope includes it), like the generic settings GET; otherwise they are null. The previous HMAC key is reported only as stored or not.',
        operationId: 'getAdyenSettings',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(adyenSettingsResponse) },
      },
    },
    async (request) => {
      const map = await readAdyenSettings();
      // Stored secrets are readable only with the permission of the generic
      // settings GET (P12); payments:read alone gets whether each is stored.
      const includeSecrets = await requestHasPermission(request, SECRET_SETTINGS_READ_PERMISSION);
      const secret = (key: string): string | null =>
        includeSecrets ? decryptedSecret(map, key) : null;
      const region = map.get('adyen.liveRegion');
      return {
        merchantAccount: plainString(map.get('adyen.merchantAccount')),
        environment: map.get('adyen.environment') === 'live' ? 'live' : 'test',
        liveUrlPrefix: plainString(map.get('adyen.liveUrlPrefix')),
        liveRegion: ADYEN_LIVE_REGIONS.find((r) => r === region) ?? 'eu',
        clientKey: plainString(map.get('adyen.clientKey')),
        webhookUsername: plainString(map.get('adyen.webhookUsername')),
        authorisationAdjustment: map.get('adyen.authorisationAdjustment') === true,
        apiKey: secret('adyen.apiKeyEnc'),
        apiKeyConfigured: configured(map.get('adyen.apiKeyEnc')),
        hmacKey: secret('adyen.hmacKeyEnc'),
        hmacKeyConfigured: configured(map.get('adyen.hmacKeyEnc')),
        hmacKeyPreviousConfigured: configured(map.get('adyen.hmacKeyPreviousEnc')),
        webhookPassword: secret('adyen.webhookPasswordEnc'),
        webhookPasswordConfigured: configured(map.get('adyen.webhookPasswordEnc')),
        webhookUrlPath: ADYEN_WEBHOOK_URL_PATH,
      };
    },
  );

  app.put(
    '/settings/adyen',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Update Adyen settings',
        description:
          'Updates the given Adyen settings. Secrets (apiKey, hmacKey, webhookPassword) are stored encrypted; an omitted field keeps its value and an empty string clears it. A live environment needs a live URL prefix. Saving does not select Adyen for new payments.',
        operationId: 'updateAdyenSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateAdyenSettingsBody),
        response: {
          200: successResponse,
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof updateAdyenSettingsBody>;

      const current = await readAdyenSettings();
      const environment = body.environment ?? current.get('adyen.environment');
      const liveUrlPrefix =
        body.liveUrlPrefix !== undefined ? body.liveUrlPrefix : current.get('adyen.liveUrlPrefix');
      if (environment === 'live' && !configured(liveUrlPrefix)) {
        await reply.status(400).send({
          error: 'A live Adyen environment needs a live URL prefix',
          code: ERROR_CODES.VALIDATION_ERROR,
          details: { liveUrlPrefix: 'Required when the environment is live' },
        });
        return;
      }

      const key = encryptionKey();
      const secret = (value: string): string => (value === '' ? '' : encryptString(value, key));
      const pairs: Array<{ key: string; value: unknown }> = [];
      if (body.apiKey !== undefined) {
        pairs.push({ key: 'adyen.apiKeyEnc', value: secret(body.apiKey) });
      }
      if (body.merchantAccount !== undefined) {
        pairs.push({ key: 'adyen.merchantAccount', value: body.merchantAccount });
      }
      if (body.clientKey !== undefined) {
        pairs.push({ key: 'adyen.clientKey', value: body.clientKey });
      }
      if (body.environment !== undefined) {
        pairs.push({ key: 'adyen.environment', value: body.environment });
      }
      if (body.liveUrlPrefix !== undefined) {
        pairs.push({ key: 'adyen.liveUrlPrefix', value: body.liveUrlPrefix });
      }
      if (body.liveRegion !== undefined) {
        pairs.push({ key: 'adyen.liveRegion', value: body.liveRegion });
      }
      if (body.hmacKey !== undefined) {
        pairs.push({ key: 'adyen.hmacKeyEnc', value: secret(body.hmacKey) });
      }
      if (body.webhookUsername !== undefined) {
        pairs.push({ key: 'adyen.webhookUsername', value: body.webhookUsername });
      }
      if (body.webhookPassword !== undefined) {
        pairs.push({ key: 'adyen.webhookPasswordEnc', value: secret(body.webhookPassword) });
      }
      if (body.authorisationAdjustment !== undefined) {
        pairs.push({ key: 'adyen.authorisationAdjustment', value: body.authorisationAdjustment });
      }

      await writePaymentSettings(request, pairs);
      return { success: true };
    },
  );

  app.post(
    '/settings/adyen/test',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Test the Adyen connection',
        description:
          'Checks the API key and merchant account with a Checkout /paymentMethods call, then reads the credential roles from the Management API. webhookRoleGranted tells whether the dashboard can create the webhook.',
        operationId: 'testAdyenConnection',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(adyenTestResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.PAYMENT_PROVIDER_CONNECTION_FAILED,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
        },
      },
    },
    async (request, reply) => {
      let provider: AdyenPaymentProvider;
      try {
        provider = await adyenProvider();
        await provider.testConnection();
      } catch (err) {
        if (err instanceof PaymentProviderNotConfiguredError) {
          await sendProviderError(err, reply);
          return;
        }
        await reply.status(400).send({
          error: err instanceof Error ? err.message : 'Connection failed',
          code: ERROR_CODES.PAYMENT_PROVIDER_CONNECTION_FAILED,
        });
        return;
      }
      // The Checkout call proved the key. A credential without any Management
      // API role cannot read /me: report no roles instead of failing the test.
      let info: AdyenCredentialInfo;
      try {
        info = await provider.getCredentialInfo();
      } catch (err) {
        request.log.warn({ err }, 'Adyen credential roles could not be read');
        info = { roles: [], allowedOrigins: [] };
      }
      return {
        success: true,
        roles: info.roles,
        webhookRoleGranted: hasAdyenWebhookRole(info.roles),
      };
    },
  );

  app.get(
    '/settings/adyen/webhook',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'Get the Adyen webhook',
        description:
          'Lists the EVtivity webhooks on the Adyen merchant account (Management API) and whether the HMAC key and Basic auth password are stored. With url, endpoints holds the webhook at that URL and otherEndpoints the ones of other EVtivity deployments sharing the merchant account.',
        operationId: 'getAdyenWebhook',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(adyenWebhookQuery),
        response: {
          200: itemResponse(adyenWebhookResponse),
          400: errorWith('Invalid URL, or Adyen is not configured or cannot be reached', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
            ERROR_CODES.PAYMENT_PROVIDER_CONNECTION_FAILED,
            ERROR_CODES.PAYMENT_PROVIDER_PERMISSION_MISSING,
          ]),
        },
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof adyenWebhookQuery>;
      let url: string | undefined;
      if (query.url !== undefined) {
        const checked = checkPaymentWebhookLookupUrl(query.url, 'adyen');
        if (!checked.ok) {
          await reply.status(400).send({
            error: 'Invalid webhook URL',
            code: ERROR_CODES.VALIDATION_ERROR,
            details: { url: checked.problem },
          });
          return;
        }
        url = checked.url;
      }
      let endpoints: WebhookEndpointInfo[];
      try {
        endpoints = await (await adyenProvider()).listWebhooks();
      } catch (err) {
        if (await sendProviderError(err, reply)) return;
        throw err;
      }
      const map = await readAdyenSettings();
      return {
        ...splitWebhookEndpoints(endpoints, url),
        hmacKeyConfigured: configured(map.get('adyen.hmacKeyEnc')),
        webhookPasswordConfigured: configured(map.get('adyen.webhookPasswordEnc')),
        events: [...ADYEN_WEBHOOK_EVENT_CODES],
      };
    },
  );

  app.post(
    '/settings/adyen/webhook',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Create the Adyen webhook',
        description: `Creates the standard webhook on the Adyen merchant account (or, with replace, updates the existing webhook at the same URL, same origin and path) with new Basic auth credentials and a new HMAC key, stores them encrypted, activates the webhook, and asks Adyen to send a test event. The URL must be https and end in ${ADYEN_WEBHOOK_URL_PATH}. EVtivity webhooks of other deployments sharing the merchant account (another URL) are never updated or deleted; the 409 lists them in otherEndpoints. The previous HMAC key stays accepted. The response carries no secrets (GET /v1/settings/adyen returns them).`,
        operationId: 'createAdyenWebhook',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createAdyenWebhookBody),
        response: {
          200: itemResponse(createAdyenWebhookResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
            ERROR_CODES.PAYMENT_PROVIDER_CONNECTION_FAILED,
            ERROR_CODES.PAYMENT_PROVIDER_PERMISSION_MISSING,
          ]),
          409: itemResponse(adyenWebhookExistsResponse),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createAdyenWebhookBody>;
      const checked = checkPaymentWebhookUrl(body.url, 'adyen');
      if (!checked.ok) {
        await reply.status(400).send({
          error: 'Invalid webhook URL',
          code: ERROR_CODES.VALIDATION_ERROR,
          details: { url: checked.problem },
        });
        return;
      }

      try {
        const provider = await adyenProvider();
        const registration = await provider.registerWebhook({
          url: checked.url,
          replace: body.replace,
        });

        // Store the credentials before Adyen sends anything (P4). A failed
        // write leaves a new webhook inactive; the retry with replace updates it.
        const key = encryptionKey();
        try {
          await writePaymentSettings(
            request,
            registration.settings.map((s) => ({
              key: s.key,
              value:
                s.secret && typeof s.value === 'string' && s.value !== ''
                  ? encryptString(s.value, key)
                  : s.value,
            })),
          );
        } catch (err) {
          request.log.error(
            { err, webhookIds: registration.endpoints.map((e) => e.id) },
            'Adyen webhook created but its credentials could not be stored',
          );
          throw err;
        }

        await registration.activate?.();
        const endpoints = registration.endpoints.map((e) => ({ ...e, active: true }));

        const webhookId = endpoints[0]?.id;
        let test: { status: string; responseCode: string | null } = {
          status: 'failed',
          responseCode: null,
        };
        if (webhookId != null) {
          try {
            const result = await provider.sendTestWebhook(webhookId);
            test = { status: result.status, responseCode: result.responseCode };
          } catch (err) {
            request.log.warn({ err }, 'Adyen test webhook could not be sent');
          }
        }
        return { endpoints, test };
      } catch (err) {
        if (await sendProviderError(err, reply)) return;
        throw err;
      }
    },
  );
}
