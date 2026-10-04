// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPlatformFeePercent } from '@evtivity/database';
import { describePaymentProviders, NO_PAYMENT_PROVIDER } from '@evtivity/payments';
import type { ProviderCatalogEntry } from '@evtivity/payments';
import { authorize } from '../middleware/rbac.js';
import { zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse, successResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { paymentRegistry } from '../lib/payments.js';
import { writePaymentSettings } from '../lib/payment-settings-writes.js';
import { providerSwitchStore, replyIfProviderUpgradePending } from '../lib/provider-switch.js';

const upgradePendingSchema = z
  .object({
    legacyConnections: z
      .number()
      .int()
      .describe('Open database connections of processes older than v0.1.38'),
    hosts: z.array(z.string()).describe('Client addresses of those connections'),
    lastLegacySeenAt: z
      .string()
      .nullable()
      .describe('When the worker watch last saw such a process (ISO 8601), or null'),
    watchCheckedAt: z
      .string()
      .nullable()
      .describe('When the worker watch last ran (ISO 8601), or null when it has not run'),
  })
  .passthrough()
  .describe('Why the provider-switch guard refuses the provider');

const providerEntrySchema = z
  .object({
    id: z.string().describe('Provider id (stripe, adyen, simulated, or a plugin id)'),
    configured: z.boolean().describe('The provider has its credentials'),
    selectable: z.boolean().describe('The provider can be selected for new payments now'),
    reason: z
      .enum(['not_configured', 'requires_upgrade'])
      .nullable()
      .describe(
        'Why the provider cannot be selected: not_configured (no credentials) or requires_upgrade (processes older than v0.1.38 are still connected, see upgradePending). Null when selectable.',
      ),
    upgradePending: upgradePendingSchema
      .nullable()
      .describe(
        'Set when processes older than v0.1.38 still block selecting this provider (provider-switch guard), else null',
      ),
    capabilities: z
      .object({
        savedMethods: z.boolean().describe('Saved cards and off-session charges'),
        clientActions: z.boolean().describe('3DS or redirect steps in the browser or app'),
        nativeMobileSheet: z.boolean().describe('Native mobile card sheet'),
        marketplaceSplit: z
          .string()
          .describe('Site host payout model: none, destination_charge or split_instructions'),
      })
      .passthrough()
      .describe('Provider capabilities the settings UI shows'),
  })
  .passthrough()
  .describe('A payment provider registered in this API process');

const paymentSettingsResponse = z
  .object({
    provider: z
      .string()
      .describe('Provider for new payments (a provider id), or none when payments are off'),
    preAuthAmountCents: z
      .number()
      .int()
      .describe('Default pre-authorization amount in cents (a site payment config overrides it)'),
    platformFeePercent: z
      .number()
      .min(0)
      .max(100)
      .describe('Default platform fee percentage (a site payment config overrides it)'),
    simulated: z
      .object({
        resultMode: z.enum(['sync', 'async']).describe('How the test provider reports results'),
        asyncDelaySeconds: z.number().describe('Delay of async test provider results in seconds'),
        randomFailureRate: z
          .number()
          .min(0)
          .max(1)
          .describe('Failure rate of test provider methods without a scenario (0 to 1)'),
      })
      .passthrough()
      .describe('Test (simulated) provider settings'),
    providers: z
      .array(providerEntrySchema)
      .describe(
        'Providers registered in this API process. The simulated provider is listed only where PAYMENTS_ALLOW_SIMULATED is true.',
      ),
  })
  .passthrough()
  .describe('Provider-neutral payment settings');

const updatePaymentSettingsBody = z.object({
  provider: z
    .string()
    .min(1)
    .optional()
    .describe('Provider for new payments: none, or the id of a selectable provider'),
  preAuthAmountCents: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .optional()
    .describe('Default pre-authorization amount in cents (1 to 1,000,000)'),
  platformFeePercent: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Default platform fee percentage (0 to 100)'),
  simulated: z
    .object({
      resultMode: z
        .enum(['sync', 'async'])
        .optional()
        .describe(
          'How the test provider reports results: sync (Stripe-like) or async (Adyen-like, confirmed by its webhook after asyncDelaySeconds)',
        ),
      asyncDelaySeconds: z
        .number()
        .int()
        .min(0)
        .max(3600)
        .optional()
        .describe('Delay of async test provider results in seconds (0 to 3600)'),
      randomFailureRate: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Failure rate of test provider methods without a scenario (0 to 1)'),
    })
    .optional()
    .describe('Test (simulated) provider settings; omitted fields keep their value'),
});

export function paymentSettingsRoutes(app: FastifyInstance): void {
  app.get(
    '/settings/payments',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'Get payment settings',
        description:
          'Returns the provider for new payments, the default pre-authorization amount and platform fee, the test provider settings, and every provider registered in this API process with whether it is configured and selectable.',
        operationId: 'getPaymentSettings',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(paymentSettingsResponse) },
      },
    },
    async () => {
      const [stored, platformFeePercent, providers] = await Promise.all([
        paymentRegistry.settings(),
        getPlatformFeePercent(null),
        describePaymentProviders(paymentRegistry, providerSwitchStore()),
      ]);
      return {
        provider: stored.provider,
        preAuthAmountCents: stored.preAuthAmountCents,
        platformFeePercent,
        simulated: { ...stored.simulated },
        providers,
      };
    },
  );

  app.put(
    '/settings/payments',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Update payment settings',
        description:
          'Updates the given payment settings; omitted fields keep their value. The provider must be none or a provider GET /v1/settings/payments lists as selectable. Selecting Adyen is refused with 409 while processes older than v0.1.38 are connected to the database, or were in the last 10 minutes. Saving provider credentials never selects a provider. Records already made keep the provider that made them.',
        operationId: 'updatePaymentSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updatePaymentSettingsBody),
        response: {
          200: successResponse,
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          409: errorWith('Processes older than v0.1.38 are still connected', [
            ERROR_CODES.PAYMENT_PROVIDER_UPGRADE_PENDING,
          ]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof updatePaymentSettingsBody>;
      const pairs: Array<{ key: string; value: unknown }> = [];

      if (body.provider !== undefined) {
        if (body.provider !== NO_PAYMENT_PROVIDER) {
          const providers = await describePaymentProviders(paymentRegistry, providerSwitchStore());
          const entry = providers.find((p) => p.id === body.provider);
          const refusal = providerRefusal(body.provider, entry);
          if (refusal != null) {
            await reply.status(400).send({
              error: refusal,
              code: ERROR_CODES.VALIDATION_ERROR,
              details: { provider: refusal },
            });
            return;
          }
        }
        pairs.push({ key: 'payments.provider', value: body.provider });
      }
      // The stripe.* forms are written too until P8, so pods of the previous
      // release read the operator's value during a rolling upgrade.
      if (body.preAuthAmountCents !== undefined) {
        pairs.push(
          { key: 'payments.preAuthAmountCents', value: body.preAuthAmountCents },
          { key: 'stripe.preAuthAmountCents', value: body.preAuthAmountCents },
        );
      }
      if (body.platformFeePercent !== undefined) {
        pairs.push(
          { key: 'payments.platformFeePercent', value: body.platformFeePercent },
          { key: 'stripe.platformFeePercent', value: body.platformFeePercent },
        );
      }
      const simulated = body.simulated ?? {};
      if (simulated.resultMode !== undefined) {
        pairs.push({ key: 'simulated.resultMode', value: simulated.resultMode });
      }
      if (simulated.asyncDelaySeconds !== undefined) {
        pairs.push({ key: 'simulated.asyncDelaySeconds', value: simulated.asyncDelaySeconds });
      }
      if (simulated.randomFailureRate !== undefined) {
        pairs.push({ key: 'simulated.randomFailureRate', value: simulated.randomFailureRate });
      }

      try {
        await writePaymentSettings(request, pairs);
      } catch (err) {
        if (await replyIfProviderUpgradePending(reply, err)) return;
        throw err;
      }
      return { success: true };
    },
  );
}

/** Why a provider cannot be selected, or null when it can. */
function providerRefusal(id: string, entry: ProviderCatalogEntry | undefined): string | null {
  if (entry == null) return `Payment provider ${id} is not available`;
  // A provider-switch guard refusal is answered by writePaymentSettings
  // (409 with the details), which checks again at write time.
  if (entry.selectable || entry.upgradePending != null) return null;
  return `Payment provider ${id} is not configured`;
}
