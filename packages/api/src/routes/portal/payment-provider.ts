// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { itemResponse } from '../../lib/response-schemas.js';
import { activePaymentProvider } from '../../lib/payments.js';

const paymentProviderDescriptor = z
  .object({
    paymentEnabled: z
      .boolean()
      .describe('A payment provider is selected and configured for new payments'),
    provider: z
      .object({
        provider: z.string().describe('Provider id the client loads its card UI for'),
      })
      .passthrough()
      .nullable()
      .describe(
        'Browser-safe client config of the active provider (Stripe: publishableKey; Adyen: clientKey, environment; simulated: resultMode, testCards). Null when payments are off.',
      ),
    capabilities: z
      .object({
        savedMethods: z.boolean().describe('Saved cards and off-session charges'),
        clientActions: z.boolean().describe('3DS or redirect steps in the browser or app'),
        nativeMobileSheet: z
          .boolean()
          .describe('The native mobile card sheet (ephemeral-key route) is available'),
      })
      .passthrough()
      .nullable()
      .describe('Capabilities of the active provider. Null when payments are off.'),
  })
  .passthrough()
  .describe('The payment provider the portal and mobile app add cards with');

export function portalPaymentProviderRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/payment-provider',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Payments'],
        summary: 'Get the active payment provider descriptor',
        description:
          'Returns the active payment provider with its browser-safe client config and capabilities, so the portal and the mobile app load the card UI of that provider. paymentEnabled is false and provider null when payments are off or the selected provider is not configured.',
        operationId: 'portalGetPaymentProvider',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(paymentProviderDescriptor) },
      },
    },
    async (request) => {
      const provider = await activePaymentProvider(request.log);
      if (provider == null) {
        return { paymentEnabled: false, provider: null, capabilities: null };
      }
      return {
        paymentEnabled: true,
        provider: provider.clientConfig(),
        capabilities: {
          savedMethods: provider.capabilities.savedMethods,
          clientActions: provider.capabilities.clientActions,
          nativeMobileSheet: provider.capabilities.nativeMobileSheet,
        },
      };
    },
  );
}
