// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

/** The active provider's card setup session, as the provider returns it (browser-safe values only). */
export const methodSetupSessionSchema = z
  .object({
    provider: z.string().describe('Provider id the client loads its card UI for'),
    customerId: z.string().describe('Provider customer the card is saved to'),
  })
  .passthrough()
  .describe(
    'Card setup session of the active provider. Stripe: clientSecret, publishableKey. Simulated: resultMode, testCards. Adyen: clientKey, environment, paymentMethodsResponse, countryCode, currency.',
  );

/** An operation an asynchronous provider accepted and has not confirmed yet (P10). */
export const pendingOperationSchema = z
  .enum(['capture', 'cancel', 'adjust'])
  .nullable()
  .optional()
  .describe(
    'Operation an asynchronous provider (Adyen) accepted and has not confirmed by webhook yet. A captured payment with a pending capture is awaiting confirmation and cannot be refunded yet.',
  );

/** The refund ledger of a payment record (`payment_records.provider_refunds`). */
export const providerRefundsSchema = z
  .array(
    z
      .object({
        refundId: z.string().describe('Provider reference of the refund'),
        paymentId: z.string().describe('Provider payment the refund is for (hold or top-up)'),
        amountCents: z.number().int().min(0).describe('Refund amount in cents'),
        state: z
          .enum(['pending', 'succeeded', 'failed'])
          .describe(
            'pending until an asynchronous provider confirms the refund, then succeeded or failed',
          ),
        requestedAt: z.string().describe('When the refund was requested (ISO 8601)'),
        settledAt: z
          .string()
          .optional()
          .describe('When the provider confirmed or failed the refund (ISO 8601)'),
      })
      .passthrough(),
  )
  .optional()
  .describe('Refunds of this payment at the provider, oldest first');
