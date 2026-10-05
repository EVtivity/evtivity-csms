// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql, and, inArray, like } from 'drizzle-orm';
import {
  db,
  client,
  writeAudit,
  siteAuditLog,
  pgErrorCode,
  PG_FOREIGN_KEY_VIOLATION,
} from '@evtivity/database';
import {
  sitePaymentConfigs,
  driverPaymentMethods,
  paymentRecords,
  paymentReconciliationRuns,
  chargingSessions,
  settings,
  chargingStations,
  sites,
  reservations,
} from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import {
  encryptString,
  dispatchDriverNotification,
  formatCurrencyAmount,
  notificationMoney,
} from '@evtivity/lib';
import {
  authorizeSessionHold,
  captureSessionHold,
  continueDriverMethodSetup,
  dispatchFeeRefundNotification,
  PaymentProviderNotConfiguredError,
  PaymentProviderPermissionError,
  refundPaymentRecord,
  removeDriverMethod,
  retryShortfallForRecord,
  runPaymentReconciliation,
  saveDriverMethod,
  setSitePayoutAccountId,
  setDefaultDriverMethod,
  startDriverMethodSetup,
  STRIPE_CONNECT_EVENTS,
  STRIPE_PLATFORM_EVENTS,
  STRIPE_WEBHOOK_API_VERSION,
  submitDriverMethodSetup,
  WebhookExistsError,
} from '@evtivity/payments';
import type {
  PaymentProvider,
  RefundOutcome,
  WebhookEndpointInfo,
  WebhookRegistration,
  WebhookRegistrationInput,
} from '@evtivity/payments';
import { zodSchema } from '../lib/zod-schema.js';
import { holdFeeCheck } from '../lib/hold-fee-check.js';
import {
  sendSetupStepOutcome,
  setupDetailsBody,
  setupStepResponses,
  setupSubmitBody,
} from '../lib/method-setup-step.js';
import { originMismatchError, shopperBrowserContext } from '../lib/shopper-browser.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import type { JwtPayload } from '../plugins/auth.js';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { getUserSiteIds } from '../lib/site-access.js';
import { paymentRecordsAtSites } from '../lib/payment-site-scope.js';
import { revokePayoutInvites } from '../services/payout-onboarding.service.js';
import { config as apiConfig } from '../lib/config.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  successResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
  errorWith,
} from '../lib/response-schemas.js';

import { ERROR_CODES } from '../lib/error-codes.generated.js';
const sitePaymentConfigItem = z
  .object({
    id: z.string().describe('Site payment configuration ID'),
    siteId: z.string().describe('Site ID this payment configuration belongs to'),
    payoutAccountId: z
      .string()
      .max(255)
      .nullable()
      .describe(
        'Payout account of the site at the payment provider (a Stripe connected account ID), null when the site has none',
      ),
    stripeConnectedAccountId: z
      .string()
      .max(255)
      .nullable()
      .describe(
        'Stripe Connect account ID for the site, if using a connected account. Deprecated: use payoutAccountId; removed in v0.1.39.',
      ),
    preAuthAmountCents: z.number().int().min(0).describe('Pre-authorization hold amount in cents'),
    platformFeePercent: z
      .string()
      .nullable()
      .describe(
        'Site-level platform fee percentage override (numeric string, null = use global default)',
      ),
    isEnabled: z.boolean().describe('Whether payments are enabled for this site'),
    payoutAccountStatus: z
      .enum(['onboarding', 'action_required', 'pending', 'active', 'disabled'])
      .nullable()
      .describe(
        'State of the connected account as last read from Stripe; only active receives destination charges (holds at the site are refused otherwise). Null when never read.',
      ),
    payoutAccountDetails: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        'Capabilities, requirements due and disabled reason of the last read (see GET /v1/sites/{id}/payout-account)',
      ),
    payoutAccountCheckedAt: z.coerce
      .date()
      .nullable()
      .describe('When the connected account was last read from Stripe'),
    createdAt: z.coerce.date().describe('Timestamp when the configuration was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the configuration was last updated'),
  })
  .passthrough();

const stripeSettingsResponse = z
  .object({
    publishableKey: z
      .unknown()
      .nullable()
      .describe('Stripe publishable API key for client-side Stripe.js'),
    secretKey: z
      .string()
      .nullable()
      .describe(
        'Stripe secret API key, decrypted. Returned only to callers that also hold settings.system:read; null otherwise and when unset (see secretKeyConfigured).',
      ),
    secretKeyConfigured: z.boolean().describe('A Stripe secret API key is stored'),
    webhookSecret: z
      .string()
      .nullable()
      .describe(
        'Signing secret of the platform webhook endpoint at /v1/webhooks/payments/stripe, decrypted. Returned only to callers that also hold settings.system:read; null otherwise and when unset (see webhookSecretConfigured).',
      ),
    webhookSecretConfigured: z
      .boolean()
      .describe('A signing secret of the platform webhook endpoint is stored'),
    connectWebhookSecret: z
      .string()
      .nullable()
      .describe(
        'Signing secret of the Connect webhook endpoint (connected account events) at /v1/webhooks/payments/stripe, decrypted. Returned only to callers that also hold settings.system:read; null otherwise and when unset (see connectWebhookSecretConfigured).',
      ),
    connectWebhookSecretConfigured: z
      .boolean()
      .describe('A signing secret of the Connect webhook endpoint is stored'),
  })
  .passthrough()
  .describe(
    'Stripe settings. The secrets are returned decrypted only to callers that also hold settings.system:read; every caller gets whether each one is stored. The pre-authorization amount and platform fee are in GET /v1/settings/payments.',
  );

const driverPaymentMethodItem = z
  .object({
    id: z.string().describe('Payment method ID'),
    driverId: z.string().describe('Driver ID this payment method belongs to'),
    provider: z
      .string()
      .max(32)
      .nullable()
      .describe('Payment provider that stores the card (stripe, simulated, adyen)'),
    providerCustomerId: z
      .string()
      .max(255)
      .nullable()
      .describe('Customer identifier of the driver at the payment provider'),
    providerPaymentMethodId: z
      .string()
      .max(255)
      .nullable()
      .describe('Payment method identifier at the payment provider'),
    stripeCustomerId: z
      .string()
      .max(255)
      .nullable()
      .describe(
        'Stripe Customer identifier for the driver; null for a card of another provider (Adyen). Deprecated: use providerCustomerId; removed in v0.1.39.',
      ),
    stripePaymentMethodId: z
      .string()
      .max(255)
      .nullable()
      .describe(
        'Stripe PaymentMethod identifier used; null for a card of another provider (Adyen). Deprecated: use providerPaymentMethodId; removed in v0.1.39.',
      ),
    cardBrand: z
      .string()
      .max(20)
      .nullable()
      .describe('Card network (visa, mastercard, amex, etc.)'),
    cardLast4: z.string().length(4).nullable().describe('Last 4 digits of the card used'),
    isDefault: z.boolean().describe('True if this is the default payment method for the driver'),
    createdAt: z.coerce.date().describe('Timestamp when the payment method was added'),
    updatedAt: z.coerce.date().describe('Timestamp when the payment method was last updated'),
  })
  .passthrough();

const setupIntentResponse = z
  .object({
    provider: z.string().describe('Payment provider the card is added with (stripe, simulated)'),
    clientSecret: z
      .string()
      .nullable()
      .describe('Stripe SetupIntent client secret used to confirm the setup on the client'),
    customerId: z.string().max(255).describe('Stripe Customer identifier for the driver'),
    publishableKey: z
      .string()
      .max(255)
      .describe('Stripe publishable API key for client-side Stripe.js'),
    session: methodSetupSessionSchema,
  })
  .passthrough();

const paymentRecordItem = z
  .object({
    id: z.string().describe('Payment record ID'),
    sessionId: z.string().nullable().describe('Charging session ID linked to this payment'),
    driverId: z.string().nullable().describe('Driver ID linked to this payment'),
    sitePaymentConfigId: z
      .string()
      .nullable()
      .describe('Site payment configuration ID used for this payment'),
    provider: z
      .string()
      .max(32)
      .nullable()
      .describe(
        'Payment provider of this payment (stripe, simulated); null for prepaid and terminal payments',
      ),
    providerPaymentId: z
      .string()
      .max(255)
      .nullable()
      .describe('Payment identifier at the payment provider (the hold or charge)'),
    providerCustomerId: z
      .string()
      .max(255)
      .nullable()
      .describe('Customer identifier of the driver at the payment provider'),
    providerPaymentMethodId: z
      .string()
      .max(255)
      .nullable()
      .describe('Payment method identifier at the payment provider used for this payment'),
    stripePaymentIntentId: z
      .string()
      .max(255)
      .nullable()
      .describe(
        'Stripe PaymentIntent identifier. Deprecated: use providerPaymentId; removed in v0.1.39.',
      ),
    stripeCustomerId: z
      .string()
      .max(255)
      .nullable()
      .describe(
        'Stripe Customer identifier for the driver. Deprecated: use providerCustomerId; removed in v0.1.39.',
      ),
    paymentSource: z
      .string()
      .max(50)
      .nullable()
      .describe('Origin of the payment (e.g. web_portal, guest_checkout)'),
    currency: z.string().length(3).describe('ISO 4217 currency code'),
    preAuthAmountCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        'Pre-authorization hold amount in cents, null for a payment without a hold (a reservation fee)',
      ),
    capturedAmountCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Amount captured from the pre-authorization in cents'),
    refundedAmountCents: z.number().int().min(0).describe('Total amount refunded in cents'),
    status: z
      .enum([
        'pending',
        'pre_authorized',
        'captured',
        'partially_refunded',
        'refunded',
        'failed',
        'cancelled',
      ])
      .describe('Payment lifecycle state'),
    failureReason: z
      .string()
      .max(500)
      .nullable()
      .describe('Error message returned by Stripe when the payment failed'),
    lastActorUserId: z
      .string()
      .nullable()
      .optional()
      .describe('Operator user ID that performed the most recent action (refund, retry capture)'),
    lastActionReason: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe('Reason recorded for the most recent operator action'),
    pendingOperation: pendingOperationSchema,
    pendingOperationAt: z.coerce
      .date()
      .nullable()
      .optional()
      .describe('When the pending operation was requested'),
    providerRefunds: providerRefundsSchema,
    createdAt: z.coerce.date().describe('Timestamp when the payment record was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the payment record was last updated'),
  })
  .passthrough();

const refundResponseItem = paymentRecordItem
  .extend({
    refundStatus: z
      .enum(['succeeded', 'pending'])
      .describe(
        'succeeded: the refund is done and counted in refundedAmountCents. pending: an asynchronous provider (Adyen) accepted it and confirms it by webhook; providerRefunds lists it as pending until then.',
      ),
  })
  .passthrough();

const RESERVATION_FEE_CHARGE_TYPES = ['reservation_cancellation', 'reservation_no_show'] as const;

const feePaymentItem = paymentRecordItem
  .extend({
    chargeType: z
      .enum(RESERVATION_FEE_CHARGE_TYPES)
      .describe('reservation_cancellation (cancellation fee) or reservation_no_show (no-show fee)'),
    reservationId: z.string().nullable().describe('Reservation the fee was charged for'),
    taxRate: z
      .string()
      .nullable()
      .describe('Tax rate the fee was charged at, as a decimal (e.g. 0.19)'),
  })
  .passthrough();

const feeRefundResponseItem = feePaymentItem
  .extend({ refundStatus: refundResponseItem.shape.refundStatus })
  .passthrough();

const preAuthFailedResponse = z
  .object({
    error: z.string().describe('Human-readable error message describing the pre-auth failure'),
    code: z.string().describe('Stable machine-readable error code'),
    paymentRecord: paymentRecordItem
      .nullable()
      .describe(
        'Payment record of the failed pre-authorization (the session already had one when not new)',
      ),
  })
  .passthrough();

const reconciliationRunItem = z
  .object({
    id: z.string().describe('Reconciliation run ID'),
    checkedCount: z
      .number()
      .int()
      .min(0)
      .describe('Number of payment records checked against Stripe'),
    matchedCount: z
      .number()
      .int()
      .min(0)
      .describe('Number of payment records that matched Stripe state'),
    discrepancyCount: z
      .number()
      .int()
      .min(0)
      .describe('Number of payment records that did not match Stripe state'),
    errorCount: z
      .number()
      .int()
      .min(0)
      .describe('Number of payment records that errored during reconciliation'),
    discrepancies: z
      .array(z.unknown())
      .nullable()
      .describe(
        'Detailed discrepancy entries from this reconciliation run. Each names the record (paymentRecordId), provider, providerPaymentId, field, localValue and providerValue; stripePaymentIntentId and stripeValue repeat providerPaymentId and providerValue (deprecated, removed in v0.1.39).',
      ),
    errors: z
      .array(z.unknown())
      .nullable()
      .describe('Detailed error entries from this reconciliation run'),
    createdAt: z.coerce.date().describe('Timestamp when the reconciliation run completed'),
  })
  .passthrough();

const reconciliationResultItem = z
  .object({
    checked: z.number().int().min(0).describe('Number of payment records checked against Stripe'),
    matched: z
      .number()
      .int()
      .min(0)
      .describe('Number of payment records that matched Stripe state'),
    discrepancies: z
      .array(z.unknown())
      .describe(
        'Detailed discrepancy entries found during reconciliation. Each names the record (paymentRecordId), provider, providerPaymentId, field, localValue and providerValue; stripePaymentIntentId and stripeValue repeat providerPaymentId and providerValue (deprecated, removed in v0.1.39).',
      ),
    errors: z
      .array(z.unknown())
      .describe('Detailed error entries encountered during reconciliation'),
  })
  .passthrough();
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { clearPaymentCaches, paymentContext, paymentRegistry } from '../lib/payments.js';
import { writePaymentSettings } from '../lib/payment-settings-writes.js';
import {
  methodSetupSessionSchema,
  pendingOperationSchema,
  providerRefundsSchema,
} from '../lib/payment-provider-schemas.js';
import {
  checkPaymentWebhookLookupUrl,
  checkPaymentWebhookUrl,
  splitWebhookEndpoints,
} from '../lib/payment-webhook-url.js';
import { decryptForRead, SECRET_SETTINGS_READ_PERMISSION } from '../lib/settings-crypto.js';

const siteIdParams = z.object({ id: ID_PARAMS.siteId.describe('Site ID') });
const driverIdParams = z.object({ id: ID_PARAMS.driverId.describe('Driver ID') });
const sessionIdParams = z.object({ id: ID_PARAMS.sessionId.describe('Charging session ID') });
const paymentMethodParams = z.object({
  id: ID_PARAMS.driverId.describe('Driver ID'),
  pmId: z.coerce.number().int().min(1).describe('Payment method ID'),
});
const reservationIdParams = z.object({ id: ID_PARAMS.reservationId.describe('Reservation ID') });
const feePaymentParams = reservationIdParams.extend({
  paymentId: z.coerce.number().int().min(1).describe('Payment record ID of the fee'),
});

/**
 * Answers a refund that was not made, for the session and the reservation
 * fee refund routes alike.
 */
async function sendRefundRefusal(
  reply: FastifyReply,
  outcome: Exclude<RefundOutcome, { status: 'refunded' }>,
): Promise<void> {
  switch (outcome.status) {
    case 'not_found':
      await reply.status(404).send({ error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
      return;
    case 'no_captured_payment':
      await reply.status(400).send({
        error: 'No captured payment to refund',
        code: 'NO_CAPTURED_PAYMENT',
      });
      return;
    case 'missing_payment_id':
      await reply.status(400).send({
        error: 'Payment intent missing',
        code: 'MISSING_PAYMENT_INTENT',
      });
      return;
    case 'not_configured':
      await reply.status(400).send({
        error: 'No payment provider configured',
        code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
      });
      return;
    case 'nothing_refundable':
    case 'exceeds_remaining': {
      const requested = outcome.status === 'exceeds_remaining' ? outcome.requestedCents : 0;
      await reply.status(409).send({
        error: `Refund amount ${String(requested)} exceeds remaining refundable balance ${String(outcome.remainingCents)}`,
        code: 'REFUND_EXCEEDS_REMAINING',
      });
      return;
    }
    case 'top_up_unknown':
      // A retry top-up made before v0.1.37 has no stored payment id, so
      // only the charges EVtivity knows can be refunded here.
      await reply.status(409).send({
        error: `This payment includes a top-up charge of ${formatCurrencyAmount(outcome.unlistedCents, outcome.currency)} with no recorded payment id. Refund up to ${formatCurrencyAmount(outcome.refundableCents, outcome.currency)} here and refund the top-up in the payment provider's dashboard.`,
        code: 'REFUND_TOP_UP_UNKNOWN',
      });
      return;
    case 'operation_pending':
      // O3: a refund of a capture the provider may still fail is refused.
      await reply.status(409).send({
        error:
          "The payment has an operation waiting for the provider's confirmation. Try again later.",
        code: 'PAYMENT_OPERATION_PENDING',
      });
      return;
  }
}

function getEncryptionKey(): string {
  const key = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (key === '') {
    throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  }
  return key;
}

/** The EVtivity webhooks of a provider that supports webhook registration. */
function listProviderWebhooks(provider: PaymentProvider): Promise<WebhookEndpointInfo[]> {
  if (provider.listWebhooks == null) {
    throw new Error(`Payment provider ${provider.id} cannot list webhooks`);
  }
  return provider.listWebhooks();
}

/** Registers the EVtivity webhooks of a provider that supports webhook registration. */
function registerProviderWebhook(
  provider: PaymentProvider,
  input: WebhookRegistrationInput,
): Promise<WebhookRegistration> {
  if (provider.registerWebhook == null) {
    throw new Error(`Payment provider ${provider.id} cannot register webhooks`);
  }
  return provider.registerWebhook(input);
}

/** 400 for a Stripe webhook setup call that Stripe or the configuration refused. */
async function sendStripeWebhookError(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): Promise<void> {
  if (err instanceof PaymentProviderNotConfiguredError) {
    await reply
      .status(400)
      .send({ error: 'Stripe is not configured', code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' });
    return;
  }
  if (err instanceof PaymentProviderPermissionError) {
    await reply.status(400).send({
      error: err.message,
      code: 'PAYMENT_PROVIDER_PERMISSION_MISSING',
      permission: err.permission,
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'Connection failed';
  request.log.warn({ error: message }, 'Stripe webhook setup call failed');
  await reply.status(400).send({ error: message, code: 'PAYMENT_PROVIDER_CONNECTION_FAILED' });
}

// --- Site payment config ---

const upsertSitePaymentConfigBody = z.object({
  payoutAccountId: z
    .string()
    .max(255)
    .nullable()
    .optional()
    .describe(
      'Payout account of the site at the payment provider (a Stripe connected account acct_... onboarded outside EVtivity); null or empty clears it, omitted keeps the current account',
    ),
  stripeConnectedAccountId: z
    .string()
    .max(255)
    .optional()
    .describe(
      'Stripe connected account (acct_...) onboarded outside EVtivity; empty clears it. Deprecated: use payoutAccountId; removed in v0.1.39. Used only when payoutAccountId is omitted; when both are sent they must match. With both omitted the current account is kept.',
    ),
  preAuthAmountCents: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Pre-authorization hold amount in cents. Omitted keeps the current amount (5000 on a new config)',
    ),
  platformFeePercent: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .describe(
      'Site-level platform fee override (null = use global default). Omitted keeps the current override (none on a new config)',
    ),
  isEnabled: z
    .boolean()
    .optional()
    .describe(
      'Whether payments are enabled for this site. Omitted keeps the current value (true on a new config)',
    ),
});

const sitePaymentConfigSaveItem = sitePaymentConfigItem.extend({
  sessionFeeCents: z
    .number()
    .int()
    .describe(
      'Highest session fee, tax included, in cents, among the tariffs that apply at the site to a driver without a pricing group (0 for a free vend site)',
    ),
  holdBelowSessionFee: z
    .boolean()
    .describe(
      'True when preAuthAmountCents is below sessionFeeCents: a guest then holds the session fee plus preAuthAmountCents at start, so raise the hold to cover the fee',
    ),
});

// --- Driver payment methods ---

const savePaymentMethodBody = z.object({
  stripePaymentMethodId: z.string().min(1).describe('Stripe payment method ID'),
  stripeCustomerId: z.string().min(1).describe('Stripe customer ID'),
  cardBrand: z.string().max(20).optional().describe('Card brand (e.g. Visa, Mastercard)'),
  cardLast4: z.string().max(4).optional().describe('Last 4 digits of the card number'),
});

// --- Session payments ---

const preAuthorizeBody = z.object({
  paymentMethodId: z.coerce.number().int().min(1).describe('Payment method ID to charge'),
  amountCents: z.number().int().min(0).optional().describe('Override pre-auth amount in cents'),
});

const captureBody = z.object({
  amountCents: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Amount to capture in cents, defaults to session cost'),
});

const refundBody = z.object({
  amountCents: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Partial refund amount in cents, defaults to full refund'),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe('Free-text reason recorded on the audit trail for this refund'),
});

// --- System Stripe settings ---

const updateStripeSettingsBody = z.object({
  secretKey: z
    .string()
    .optional()
    .describe('Stripe secret API key (stored encrypted). An empty string clears it.'),
  publishableKey: z.string().min(1).optional().describe('Stripe publishable API key'),
  webhookSecret: z
    .string()
    .optional()
    .describe(
      'Signing secret (whsec_...) of the platform webhook endpoint at /v1/webhooks/payments/stripe (stored encrypted). An empty string clears it.',
    ),
  connectWebhookSecret: z
    .string()
    .optional()
    .describe(
      'Signing secret (whsec_...) of the Connect webhook endpoint at /v1/webhooks/payments/stripe (stored encrypted). An empty string clears it.',
    ),
});

// --- Stripe webhook setup ---

const webhookEndpointItem = z
  .object({
    id: z.string().describe('Provider id of the webhook endpoint (we_... for Stripe)'),
    url: z.string().describe('URL the provider sends the events to'),
    scope: z
      .string()
      .describe('platform (payment events) or connect (connected account events) for Stripe'),
    enabledEvents: z.array(z.string()).describe('Event types the endpoint receives'),
    apiVersion: z
      .string()
      .nullable()
      .describe('API version of the event payloads; null when the account default applies'),
    active: z.boolean().describe('Whether the provider currently sends events to the endpoint'),
  })
  .passthrough();

const otherWebhookEndpoints = z
  .array(webhookEndpointItem)
  .describe(
    'EVtivity endpoints of other deployments sharing the provider account (another URL). Creating or replacing the webhook never changes them.',
  );

const stripeWebhookSetupResponse = z
  .object({
    endpoints: z
      .array(webhookEndpointItem)
      .describe(
        'Webhook endpoints EVtivity created in the Stripe account at the url query (every EVtivity endpoint without url)',
      ),
    otherEndpoints: otherWebhookEndpoints,
    platformSecretConfigured: z
      .boolean()
      .describe('Whether the platform signing secret (stripe.webhookSecretEnc) is stored'),
    connectSecretConfigured: z
      .boolean()
      .describe('Whether the Connect signing secret (stripe.connectWebhookSecretEnc) is stored'),
    events: z
      .object({
        platform: z.array(z.string()).describe('Events of the platform endpoint'),
        connect: z.array(z.string()).describe('Events of the Connect endpoint'),
      })
      .passthrough()
      .describe('Events a new registration subscribes to'),
    apiVersion: z.string().describe('Stripe API version of the endpoints EVtivity creates'),
  })
  .passthrough();

const stripeWebhookRegistrationResponse = z
  .object({
    endpoints: z
      .array(webhookEndpointItem)
      .describe(
        'The endpoints created, followed by any earlier endpoint at this URL Stripe did not delete',
      ),
  })
  .passthrough();

const webhookExistsResponse = z
  .object({
    error: z.string().describe('Default: "An EVtivity webhook already exists for this provider"'),
    code: z.literal('PAYMENT_WEBHOOK_EXISTS').describe('Error code returned at this status'),
    endpoints: z
      .array(webhookEndpointItem)
      .describe('The endpoints at the requested URL; send replace: true to replace them'),
    otherEndpoints: otherWebhookEndpoints,
  })
  .passthrough()
  .describe('An EVtivity webhook already exists');

const createStripeWebhookBody = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      'Public https URL of this API ending in exactly /v1/webhooks/payments/stripe (the CSMS shows it; edit it for a tunnel)',
    ),
  replace: z
    .boolean()
    .describe(
      'Replace the endpoints that already exist at this URL (after the operator confirms). Endpoints of other EVtivity deployments at other URLs are never changed.',
    ),
});

const stripeWebhookSetupQuery = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      'Webhook URL of this deployment (http or https, ending in /v1/webhooks/payments/stripe). Splits the EVtivity endpoints into the ones at this URL and the ones of other deployments.',
    ),
});

export function paymentRoutes(app: FastifyInstance): void {
  // ---- Site Payment Config ----

  app.get(
    '/sites/:id/payment-config',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'Get payment configuration for a site',
        operationId: 'getSitePaymentConfig',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        response: {
          200: itemResponse(sitePaymentConfigItem),
          404: errorWith('Payment config not found', [ERROR_CODES.PAYMENT_CONFIG_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteIdParams>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({
          error: 'No payment config for this site',
          code: 'PAYMENT_CONFIG_NOT_FOUND',
        });
        return;
      }

      const [config] = await db
        .select({
          id: sitePaymentConfigs.id,
          siteId: sitePaymentConfigs.siteId,
          payoutAccountId: sitePaymentConfigs.payoutAccountId,
          stripeConnectedAccountId: sitePaymentConfigs.stripeConnectedAccountId,
          preAuthAmountCents: sitePaymentConfigs.preAuthAmountCents,
          platformFeePercent: sitePaymentConfigs.platformFeePercent,
          isEnabled: sitePaymentConfigs.isEnabled,
          payoutAccountStatus: sitePaymentConfigs.payoutAccountStatus,
          payoutAccountDetails: sitePaymentConfigs.payoutAccountDetails,
          payoutAccountCheckedAt: sitePaymentConfigs.payoutAccountCheckedAt,
          createdAt: sitePaymentConfigs.createdAt,
          updatedAt: sitePaymentConfigs.updatedAt,
        })
        .from(sitePaymentConfigs)
        .where(eq(sitePaymentConfigs.siteId, id));

      if (config == null) {
        await reply.status(404).send({
          error: 'No payment config for this site',
          code: 'PAYMENT_CONFIG_NOT_FOUND',
        });
        return;
      }
      return config;
    },
  );

  async function writeSitePaymentConfigAudit(
    request: FastifyRequest,
    siteId: string,
    before: Record<string, unknown> | null | undefined,
    after: Record<string, unknown> | null | undefined,
  ): Promise<void> {
    const actor = getAuditActor(request);
    await writeAudit(
      { table: siteAuditLog, idColumn: 'site_id' },
      {
        entityId: siteId,
        entityIdSnapshot: siteId,
        action: 'payment_config_changed',
        ...actor,
        before: before ?? null,
        after: after ?? null,
      },
      db,
      request.log,
    );
  }

  /**
   * The connected account field of the site config goes through the payout
   * account service (the only writer of the account columns): a changed id
   * forgets the old status, is read from Stripe (fail open) and revokes the
   * open onboarding links of the old account.
   */
  async function applyPayoutAccountId(
    request: FastifyRequest,
    siteId: string,
    accountId: string | null,
  ): Promise<void> {
    if (await setSitePayoutAccountId(siteId, accountId, paymentContext(request.log))) {
      await revokePayoutInvites(siteId);
    }
  }

  app.put(
    '/sites/:id/payment-config',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Create or update payment configuration for a site',
        description:
          'Saves the hold amount, platform fee override, enabled flag and connected account of the site (payoutAccountId, or the deprecated stripeConnectedAccountId; both sent with different values is 400 VALIDATION_ERROR). With neither field sent the account and its open onboarding link are kept; null or empty clears the account. A changed connected account ID is read from Stripe at once (payoutAccountStatus in the response) and revokes the open onboarding link. A config with a connected account that is not active still saves, but holds at the site are refused (409 PAYOUT_ACCOUNT_NOT_READY on the operator pre-auth) until the account is active.',
        operationId: 'upsertSitePaymentConfig',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        body: zodSchema(upsertSitePaymentConfigBody),
        response: {
          200: itemResponse(sitePaymentConfigSaveItem),
          400: errorWith('payoutAccountId and stripeConnectedAccountId differ', [
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Site or payment config not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.PAYMENT_CONFIG_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteIdParams>;
      const body = request.body as z.infer<typeof upsertSitePaymentConfigBody>;

      // payoutAccountId wins; the deprecated stripeConnectedAccountId (D-P7,
      // removed in P8) is used only when it is omitted. Both sent must name
      // the same account (null and empty both clear it).
      const normalizedAccountId = (value: string | null | undefined): string | null =>
        value == null || value.trim() === '' ? null : value.trim();
      if (
        body.payoutAccountId !== undefined &&
        body.stripeConnectedAccountId !== undefined &&
        normalizedAccountId(body.payoutAccountId) !==
          normalizedAccountId(body.stripeConnectedAccountId)
      ) {
        await reply.status(400).send({
          error: 'payoutAccountId and stripeConnectedAccountId differ',
          code: 'VALIDATION_ERROR',
          details: {
            payoutAccountId:
              'Send the account in payoutAccountId only; stripeConnectedAccountId is deprecated and must match it when sent',
          },
        });
        return;
      }
      // Undefined (neither field sent, e.g. the enabled toggle) keeps the
      // account and its open onboarding link; null or empty clears it.
      const accountId =
        body.payoutAccountId !== undefined ? body.payoutAccountId : body.stripeConnectedAccountId;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({
          error: 'No payment config for this site',
          code: 'PAYMENT_CONFIG_NOT_FOUND',
        });
        return;
      }

      // The siteIds filter above only guards non-all-access operators.
      // All-site-access admins still need an explicit site existence check
      // so the INSERT below cannot create a row with a dangling siteId FK.
      const [siteRow] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id));
      if (siteRow == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [existing] = await db
        .select()
        .from(sitePaymentConfigs)
        .where(eq(sitePaymentConfigs.siteId, id));

      if (existing != null) {
        await db
          .update(sitePaymentConfigs)
          .set({
            // Omitted fields keep their stored value (the enabled toggle
            // sends only isEnabled); an explicit null fee clears the override.
            ...(body.isEnabled !== undefined && { isEnabled: body.isEnabled }),
            ...(body.preAuthAmountCents !== undefined && {
              preAuthAmountCents: body.preAuthAmountCents,
            }),
            ...(body.platformFeePercent !== undefined && {
              platformFeePercent:
                body.platformFeePercent != null ? String(body.platformFeePercent) : null,
            }),
            updatedAt: new Date(),
          })
          .where(eq(sitePaymentConfigs.siteId, id));
        if (accountId !== undefined) {
          await applyPayoutAccountId(request, id, normalizedAccountId(accountId));
        }
        clearPaymentCaches();
        const [updated] = await db
          .select()
          .from(sitePaymentConfigs)
          .where(eq(sitePaymentConfigs.siteId, id));
        await writeSitePaymentConfigAudit(request, id, existing, updated);
        return { ...updated, ...(await holdFeeCheck(id, updated?.preAuthAmountCents ?? 0)) };
      }

      let created;
      try {
        [created] = await db
          .insert(sitePaymentConfigs)
          .values({
            siteId: id,
            preAuthAmountCents: body.preAuthAmountCents ?? 5000,
            platformFeePercent:
              body.platformFeePercent != null ? String(body.platformFeePercent) : null,
            isEnabled: body.isEnabled ?? true,
          })
          .returning();
      } catch (err) {
        // Pre-check is non-transactional, so the site can be deleted between
        // the check and this INSERT. Map the FK violation back to 404.
        if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
          await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
          return;
        }
        throw err;
      }
      const newAccountId = normalizedAccountId(accountId);
      if (newAccountId != null) {
        await applyPayoutAccountId(request, id, newAccountId);
        [created] = await db
          .select()
          .from(sitePaymentConfigs)
          .where(eq(sitePaymentConfigs.siteId, id));
      }
      clearPaymentCaches();
      await writeSitePaymentConfigAudit(request, id, null, created);
      return { ...created, ...(await holdFeeCheck(id, created?.preAuthAmountCents ?? 0)) };
    },
  );

  app.delete(
    '/sites/:id/payment-config',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Delete payment configuration for a site',
        description:
          'Deletes the site payment configuration with its connected account, and revokes the open payout onboarding links of the site. A configuration that payments were made with cannot be deleted (409 SITE_PAYMENT_CONFIG_IN_USE): disable it instead (isEnabled false).',
        operationId: 'deleteSitePaymentConfig',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        response: {
          200: successResponse,
          404: errorWith('Payment config not found', [ERROR_CODES.PAYMENT_CONFIG_NOT_FOUND]),
          409: errorWith('Payments were made with this config', [
            ERROR_CODES.SITE_PAYMENT_CONFIG_IN_USE,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteIdParams>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({
          error: 'No payment config for this site',
          code: 'PAYMENT_CONFIG_NOT_FOUND',
        });
        return;
      }

      let deleted;
      try {
        [deleted] = await db
          .delete(sitePaymentConfigs)
          .where(eq(sitePaymentConfigs.siteId, id))
          .returning();
      } catch (err) {
        // payment_records.site_payment_config_id references this row with no
        // cascade: a config payments were made with is kept for their history.
        if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
          await reply.status(409).send({
            error:
              "This site's payment configuration has payments and cannot be deleted. Disable it instead.",
            code: 'SITE_PAYMENT_CONFIG_IN_USE',
          });
          return;
        }
        throw err;
      }

      if (deleted == null) {
        await reply.status(404).send({
          error: 'No payment config for this site',
          code: 'PAYMENT_CONFIG_NOT_FOUND',
        });
        return;
      }
      // The connected account went with the config, so its open onboarding
      // links must not stay usable (as when the account id changes).
      await revokePayoutInvites(id);
      clearPaymentCaches();
      await writeSitePaymentConfigAudit(request, id, deleted, null);
      return { success: true };
    },
  );

  // ---- System Stripe Settings ----

  app.get(
    '/settings/stripe',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'Get system Stripe settings',
        description:
          'Returns the Stripe settings and whether each secret is stored. The secret key and the webhook signing secrets are returned decrypted only when the caller also holds settings.system:read (for an API key, when its scope includes it), like the generic settings GET; otherwise they are null.',
        operationId: 'getStripeSettings',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(stripeSettingsResponse) },
      },
    },
    async (request) => {
      // Push the stripe.* prefix filter to Postgres so the admin Settings
      // page doesn't drag the entire settings table over the wire just to
      // pick a few keys. Stored secrets are readable only with the permission
      // of the generic settings GET (P12), so payments:read alone gets whether
      // each one is stored.
      const rows = await db.select().from(settings).where(like(settings.key, 'stripe.%'));
      const map = new Map<string, unknown>();
      for (const row of rows) {
        map.set(row.key, row.value);
      }
      const includeSecrets = await requestHasPermission(request, SECRET_SETTINGS_READ_PERMISSION);
      const stored = (key: string): boolean => {
        const value = map.get(key);
        return typeof value === 'string' && value !== '';
      };
      const secret = (key: string): string | null => {
        if (!includeSecrets) return null;
        const value = decryptForRead(key, map.get(key));
        return typeof value === 'string' && value !== '' ? value : null;
      };
      return {
        publishableKey: map.get('stripe.publishableKey') ?? null,
        secretKey: secret('stripe.secretKeyEnc'),
        secretKeyConfigured: stored('stripe.secretKeyEnc'),
        webhookSecret: secret('stripe.webhookSecretEnc'),
        webhookSecretConfigured: stored('stripe.webhookSecretEnc'),
        connectWebhookSecret: secret('stripe.connectWebhookSecretEnc'),
        connectWebhookSecretConfigured: stored('stripe.connectWebhookSecretEnc'),
      };
    },
  );

  app.put(
    '/settings/stripe',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Update system Stripe settings',
        description:
          'Updates the given Stripe settings. Secrets (secretKey, webhookSecret, connectWebhookSecret) are stored encrypted; an omitted field keeps its value and an empty string clears it. Saving does not select Stripe for new payments, and the pre-authorization amount and platform fee are set with PUT /v1/settings/payments.',
        operationId: 'updateStripeSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateStripeSettingsBody),
        response: { 200: successResponse },
      },
    },
    async (request) => {
      const body = request.body as z.infer<typeof updateStripeSettingsBody>;
      const encryptionKey = getEncryptionKey();

      const pairs: Array<{ key: string; value: unknown }> = [];
      // Secrets: omitted keeps the stored value, empty clears it.
      const secret = (value: string): string =>
        value === '' ? '' : encryptString(value, encryptionKey);

      if (body.secretKey !== undefined) {
        pairs.push({ key: 'stripe.secretKeyEnc', value: secret(body.secretKey) });
      }
      if (body.publishableKey != null) {
        pairs.push({ key: 'stripe.publishableKey', value: body.publishableKey });
      }
      if (body.webhookSecret !== undefined) {
        pairs.push({ key: 'stripe.webhookSecretEnc', value: secret(body.webhookSecret) });
      }
      if (body.connectWebhookSecret !== undefined) {
        pairs.push({
          key: 'stripe.connectWebhookSecretEnc',
          value: secret(body.connectWebhookSecret),
        });
      }
      await writePaymentSettings(request, pairs);

      return { success: true };
    },
  );

  // ---- Stripe Connection Test ----

  app.post(
    '/settings/stripe/test',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Test Stripe API connection',
        operationId: 'testStripeConnection',
        security: [{ bearerAuth: [] }],
        response: {
          200: successResponse,
          400: errorWith('Bad request', [
            ERROR_CODES.PAYMENT_PROVIDER_CONNECTION_FAILED,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
        },
      },
    },
    async (_request, reply) => {
      try {
        const provider = await paymentRegistry.getPaymentProvider('stripe');
        await provider.testConnection();
        return { success: true };
      } catch (err: unknown) {
        if (err instanceof PaymentProviderNotConfiguredError) {
          await reply.status(400).send({
            error: 'Stripe is not configured',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        }
        const message = err instanceof Error ? err.message : 'Connection failed';
        await reply.status(400).send({
          error: message,
          code: 'PAYMENT_PROVIDER_CONNECTION_FAILED',
        });
        return;
      }
    },
  );

  // ---- Stripe Webhook Setup ----

  app.get(
    '/settings/stripe/webhook',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'Get the Stripe webhook setup',
        description:
          'Lists the webhook endpoints EVtivity created in the Stripe account (marked with metadata evtivity_scope), whether the platform and Connect signing secrets are stored, and the events and API version a new registration uses. With url, endpoints holds the ones at that URL and otherEndpoints the ones of other EVtivity deployments sharing the Stripe account.',
        operationId: 'getStripeWebhookSetup',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(stripeWebhookSetupQuery),
        response: {
          200: itemResponse(stripeWebhookSetupResponse),
          400: errorWith('Invalid URL, or Stripe is not configured or refused the call', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
            ERROR_CODES.PAYMENT_PROVIDER_PERMISSION_MISSING,
            ERROR_CODES.PAYMENT_PROVIDER_CONNECTION_FAILED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof stripeWebhookSetupQuery>;
      let url: string | undefined;
      if (query.url !== undefined) {
        const checked = checkPaymentWebhookLookupUrl(query.url, 'stripe');
        if (!checked.ok) {
          await reply.status(400).send({
            error: 'Invalid webhook URL',
            code: 'VALIDATION_ERROR',
            details: { url: checked.problem },
          });
          return;
        }
        url = checked.url;
      }
      let endpoints: WebhookEndpointInfo[];
      try {
        const provider = await paymentRegistry.getPaymentProvider('stripe');
        endpoints = await listProviderWebhooks(provider);
      } catch (err) {
        await sendStripeWebhookError(request, reply, err);
        return;
      }
      const rows = await db
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(
          inArray(settings.key, ['stripe.webhookSecretEnc', 'stripe.connectWebhookSecretEnc']),
        );
      const stored = (key: string): boolean =>
        rows.some((row) => row.key === key && typeof row.value === 'string' && row.value !== '');
      return {
        ...splitWebhookEndpoints(endpoints, url),
        platformSecretConfigured: stored('stripe.webhookSecretEnc'),
        connectSecretConfigured: stored('stripe.connectWebhookSecretEnc'),
        events: { platform: [...STRIPE_PLATFORM_EVENTS], connect: [...STRIPE_CONNECT_EVENTS] },
        apiVersion: STRIPE_WEBHOOK_API_VERSION,
      };
    },
  );

  app.post(
    '/settings/stripe/webhook',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Create the Stripe webhooks',
        description:
          'Creates two webhook endpoints in the Stripe account at the given URL: the platform endpoint (payment_intent.payment_failed, charge.refunded, charge.dispute.created) and the Connect endpoint (account.updated of connected accounts), and stores their signing secrets encrypted (stripe.webhookSecretEnc, stripe.connectWebhookSecretEnc). The URL must be https and end in exactly /v1/webhooks/payments/stripe. Existing EVtivity endpoints at the same URL (same origin and path) are replaced only with replace: true (deleted after the new ones exist). EVtivity endpoints of other deployments sharing the Stripe account (another URL) are never deleted; the 409 lists them in otherEndpoints. The response carries no secrets (GET /v1/settings/stripe returns them).',
        operationId: 'createStripeWebhook',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createStripeWebhookBody),
        response: {
          200: itemResponse(stripeWebhookRegistrationResponse),
          400: errorWith('Invalid URL, or Stripe is not configured or refused the call', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
            ERROR_CODES.PAYMENT_PROVIDER_PERMISSION_MISSING,
            ERROR_CODES.PAYMENT_PROVIDER_CONNECTION_FAILED,
          ]),
          409: itemResponse(webhookExistsResponse),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createStripeWebhookBody>;
      const checked = checkPaymentWebhookUrl(body.url, 'stripe');
      if (!checked.ok) {
        await reply.status(400).send({
          error: 'Invalid webhook URL',
          code: 'VALIDATION_ERROR',
          details: { url: checked.problem },
        });
        return;
      }

      let registration: WebhookRegistration;
      try {
        const provider = await paymentRegistry.getPaymentProvider('stripe');
        registration = await registerProviderWebhook(provider, {
          url: checked.url,
          replace: body.replace,
        });
      } catch (err) {
        if (err instanceof WebhookExistsError) {
          await reply.status(409).send({
            error: 'An EVtivity webhook already exists for this provider',
            code: 'PAYMENT_WEBHOOK_EXISTS',
            endpoints: err.endpoints,
            otherEndpoints: err.otherEndpoints,
          });
          return;
        }
        await sendStripeWebhookError(request, reply, err);
        return;
      }

      const encryptionKey = getEncryptionKey();
      const pairs = registration.settings.map(({ key, value, secret }) => ({
        key,
        value: secret ? encryptString(String(value), encryptionKey) : value,
      }));
      try {
        await writePaymentSettings(request, pairs);
      } catch (err) {
        // The endpoints exist in Stripe without stored secrets. Creating the
        // webhook again with replace finds and replaces them.
        request.log.error(
          { err, endpoints: registration.endpoints.map((e) => e.id) },
          'Stripe webhook endpoints created but their signing secrets could not be stored',
        );
        throw err;
      }
      request.log.info(
        { endpoints: registration.endpoints.map((e) => e.id), replace: body.replace },
        'Stripe webhook endpoints created',
      );
      return { endpoints: registration.endpoints };
    },
  );

  // ---- All Site Payment Configs ----

  app.get(
    '/sites/payment-configs',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'List all site payment configurations',
        operationId: 'listSitePaymentConfigs',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(sitePaymentConfigItem) },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];
      if (siteIds != null) {
        return db
          .select()
          .from(sitePaymentConfigs)
          .where(inArray(sitePaymentConfigs.siteId, siteIds));
      }
      return db.select().from(sitePaymentConfigs);
    },
  );

  // ---- Driver Payment Methods ----

  app.get(
    '/drivers/:id/payment-methods',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'List payment methods for a driver',
        operationId: 'listDriverPaymentMethods',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverIdParams),
        response: { 200: arrayResponse(driverPaymentMethodItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof driverIdParams>;
      return db.select().from(driverPaymentMethods).where(eq(driverPaymentMethods.driverId, id));
    },
  );

  app.post(
    '/drivers/:id/payment-methods/setup-intent',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Create a Stripe setup intent for a driver',
        operationId: 'createDriverSetupIntent',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverIdParams),
        response: {
          200: itemResponse(setupIntentResponse),
          400: errorWith('Stripe not configured', [ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED]),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverIdParams>;
      const result = await startDriverMethodSetup(
        { driverId: id, channel: 'web' },
        paymentContext(request.log),
      );
      if (result.status === 'driver_not_found') {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      if (result.status === 'not_configured') {
        await reply.status(400).send({
          error: 'No payment provider configured',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
      if (result.status === 'failed') {
        await reply.status(400).send({
          error: `The payment provider rejected the request: ${result.reason}`,
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
      const session = result.session as { clientSecret?: unknown; publishableKey?: unknown };
      return {
        provider: result.providerId,
        clientSecret: typeof session.clientSecret === 'string' ? session.clientSecret : null,
        customerId: result.customerId,
        publishableKey: typeof session.publishableKey === 'string' ? session.publishableKey : '',
        session: result.session,
      };
    },
  );

  app.post(
    '/drivers/:id/payment-methods',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Save a payment method for a driver',
        operationId: 'createDriverPaymentMethod',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverIdParams),
        body: zodSchema(savePaymentMethodBody),
        response: {
          201: itemResponse(driverPaymentMethodItem),
          400: errorWith('Payment provider not configured', [
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          403: errorWith('Method not attached to the customer', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverIdParams>;
      const body = request.body as z.infer<typeof savePaymentMethodBody>;
      // The operator adds a card for the driver: a driver without a customer
      // takes the customer of the setup; the provider checks the method is
      // attached to it.
      const result = await saveDriverMethod(
        {
          driverId: id,
          customerId: body.stripeCustomerId,
          methodId: body.stripePaymentMethodId,
          adoptCustomer: true,
        },
        paymentContext(request.log),
      );
      switch (result.status) {
        case 'saved':
          await reply.status(201).send(result.method);
          return;
        case 'driver_not_found':
          await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
          return;
        case 'forbidden':
          await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
          return;
        case 'not_initialized':
        case 'not_configured':
          await reply.status(400).send({
            error: 'No payment provider configured',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        case 'verify_failed':
          await reply.status(400).send({
            error: 'Could not verify payment method',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
      }
    },
  );

  app.post(
    '/drivers/:id/payment-methods/setup/submit',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Submit a card collected for a driver by the payment provider card UI',
        description:
          "Saves the card the active provider's card UI collected after POST /v1/drivers/{id}/payment-methods/setup-intent. The customer is the driver's own at that provider (created when the driver has none). Returns 201 with the saved method, or 200 with an action (3D Secure, test provider challenge) whose result goes to setup/details. A card that can ask for 3D Secure (Adyen) needs browser: the issuer returns the operator to CSMS_URL/payments/return?flow=method&provider=&attemptId=&driverId=, and browser.origin must be the CSMS_URL origin (else 400 VALIDATION_ERROR). A refused card is 400 PAYMENT_FAILED with details.reason. The same attemptId returns the same method.",
        operationId: 'submitDriverPaymentMethodSetup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverIdParams),
        body: zodSchema(setupSubmitBody),
        response: setupStepResponses(driverPaymentMethodItem),
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverIdParams>;
      const body = request.body as z.infer<typeof setupSubmitBody>;
      // The dashboard's 3DS return page posts the redirect result to
      // setup/details with the driver, provider and attemptId from its query.
      const browser =
        body.browser != null
          ? shopperBrowserContext(body.browser, apiConfig.CSMS_URL, '/payments/return', {
              flow: 'method',
              provider: body.provider,
              attemptId: body.attemptId,
              driverId: id,
            })
          : undefined;
      if (browser === null) {
        await reply.status(400).send(originMismatchError(apiConfig.CSMS_URL));
        return;
      }
      // The operator adds a card for the driver: a driver without a customer
      // at the provider gets one, as on the Stripe save route.
      const outcome = await submitDriverMethodSetup(
        {
          driverId: id,
          providerId: body.provider,
          attemptId: body.attemptId,
          payload: body.payload,
          ...(browser != null ? { browser } : {}),
          adoptCustomer: true,
        },
        paymentContext(request.log),
      );
      await sendSetupStepOutcome(reply, outcome, (method) => method);
    },
  );

  app.post(
    '/drivers/:id/payment-methods/setup/details',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Continue a card setup for a driver after a client action',
        description:
          'Sends the result of the action setup/submit returned (3D Secure, test provider challenge) with the same attemptId. Returns 201 with the saved method, 200 with a further action, or 400 PAYMENT_FAILED when the card is refused.',
        operationId: 'continueDriverPaymentMethodSetup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverIdParams),
        body: zodSchema(setupDetailsBody),
        response: setupStepResponses(driverPaymentMethodItem),
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverIdParams>;
      const body = request.body as z.infer<typeof setupDetailsBody>;
      const outcome = await continueDriverMethodSetup(
        {
          driverId: id,
          providerId: body.provider,
          attemptId: body.attemptId,
          details: body.details,
        },
        paymentContext(request.log),
      );
      await sendSetupStepOutcome(reply, outcome, (method) => method);
    },
  );

  app.delete(
    '/drivers/:id/payment-methods/:pmId',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Delete a payment method for a driver',
        operationId: 'deleteDriverPaymentMethod',
        security: [{ bearerAuth: [] }],
        params: zodSchema(paymentMethodParams),
        response: {
          200: successResponse,
          404: errorWith('Payment method not found', [ERROR_CODES.PAYMENT_METHOD_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, pmId } = request.params as z.infer<typeof paymentMethodParams>;
      const result = await removeDriverMethod(
        { driverId: id, methodRowId: pmId, blockWhenInUse: false },
        paymentContext(request.log),
      );
      if (result.status === 'not_found') {
        await reply.status(404).send({
          error: 'Payment method not found',
          code: 'PAYMENT_METHOD_NOT_FOUND',
        });
        return;
      }
      return { success: true };
    },
  );

  app.patch(
    '/drivers/:id/payment-methods/:pmId/default',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Set a payment method as default for a driver',
        operationId: 'setDefaultDriverPaymentMethod',
        security: [{ bearerAuth: [] }],
        params: zodSchema(paymentMethodParams),
        response: {
          200: itemResponse(driverPaymentMethodItem),
          404: errorWith('Payment method not found', [ERROR_CODES.PAYMENT_METHOD_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, pmId } = request.params as z.infer<typeof paymentMethodParams>;
      const updated = await setDefaultDriverMethod(id, pmId);
      if (updated == null) {
        await reply.status(404).send({
          error: 'Payment method not found',
          code: 'PAYMENT_METHOD_NOT_FOUND',
        });
        return;
      }
      return updated;
    },
  );

  // ---- Session Payments ----

  app.post(
    '/sessions/:id/pre-authorize',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Pre-authorize a payment for a charging session',
        operationId: 'preAuthorizeSessionPayment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        body: zodSchema(preAuthorizeBody),
        response: {
          200: itemResponse(paymentRecordItem),
          400: itemResponse(preAuthFailedResponse),
          404: errorWith('Resource not found', [
            ERROR_CODES.PAYMENT_METHOD_NOT_FOUND,
            ERROR_CODES.SESSION_NOT_FOUND,
          ]),
          409: itemResponse(
            preAuthFailedResponse.describe(
              'PAYOUT_ACCOUNT_NOT_READY: the payout account of the site cannot receive payments yet (not active in Stripe); no hold was placed and a failed payment record was written',
            ),
          ),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionIdParams>;
      const body = request.body as z.infer<typeof preAuthorizeBody>;

      const [session] = await db
        .select({
          id: chargingSessions.id,
          driverId: chargingSessions.driverId,
          siteId: chargingStations.siteId,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
        .where(eq(chargingSessions.id, id));
      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      // Same key as the portal start and the OCPP gate (preauth_<sessionId>,
      // P7): a retried request, or a pre-auth after the gate already placed
      // one, returns the existing record instead of a second hold.
      const outcome = await authorizeSessionHold(
        {
          sessionId: session.id,
          driverId: session.driverId,
          methodRowId: body.paymentMethodId,
          siteId: session.siteId,
          ...(body.amountCents != null ? { amountCents: body.amountCents } : {}),
          trigger: 'operator',
        },
        paymentContext(request.log),
      );
      const recordOf = async (recordId: number | null): Promise<unknown> => {
        if (recordId == null) return null;
        const [row] = await db.select().from(paymentRecords).where(eq(paymentRecords.id, recordId));
        return row ?? null;
      };
      switch (outcome.outcome) {
        case 'authorized':
          return recordOf(outcome.paymentRecordId);
        case 'exists': {
          const existing = await recordOf(outcome.paymentRecordId);
          if (outcome.status === 'pre_authorized') return existing;
          await reply.status(400).send({
            error: 'The session already has a payment record',
            code: 'PRE_AUTH_FAILED',
            paymentRecord: existing,
          });
          return;
        }
        case 'declined': {
          const [record] =
            outcome.paymentRecordId != null
              ? await db
                  .select()
                  .from(paymentRecords)
                  .where(eq(paymentRecords.id, outcome.paymentRecordId))
              : await db.select().from(paymentRecords).where(eq(paymentRecords.sessionId, id));
          if (outcome.code === 'payout_account_not_ready') {
            await reply.status(409).send({
              error: "The site's payout account cannot receive payments yet",
              code: 'PAYOUT_ACCOUNT_NOT_READY',
              paymentRecord: record ?? null,
            });
            return;
          }
          await reply.status(400).send({
            error: outcome.reason,
            code: 'PRE_AUTH_FAILED',
            paymentRecord: record ?? null,
          });
          return;
        }
        case 'no_method':
          await reply.status(404).send({
            error: 'Payment method not found',
            code: 'PAYMENT_METHOD_NOT_FOUND',
          });
          return;
        case 'not_configured':
          // The 400 body of this route carries the payment record (none here).
          await reply.status(400).send({
            error: 'No payment provider configured',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
            paymentRecord: null,
          });
          return;
        case 'record_failed':
          // The hold was cancelled again; the global handler answers 500.
          throw new Error(`Failed to record the pre-authorization: ${outcome.reason}`);
      }
    },
  );

  app.post(
    '/sessions/:id/capture',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Capture a pre-authorized payment for a session',
        description:
          'Captures a previously pre-authorized PaymentIntent in Stripe up to the supplied amount and updates the payment record to captured. When the requested amount is zero, the PaymentIntent is cancelled instead. Returns 400 if the payment is not in pre_authorized state.',
        operationId: 'captureSessionPayment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        body: zodSchema(captureBody),
        response: {
          200: itemResponse(paymentRecordItem),
          400: errorWith('Bad request', [
            ERROR_CODES.MISSING_PAYMENT_INTENT,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          404: errorWith('No pre auth', [ERROR_CODES.NO_PRE_AUTH]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionIdParams>;
      const body = request.body as z.infer<typeof captureBody>;
      // The session's final cost when no amount is given; a 0 amount cancels
      // the hold. The platform fee is a percent of the net amount captured.
      const outcome = await captureSessionHold(
        { sessionId: id, ...(body.amountCents != null ? { amountCents: body.amountCents } : {}) },
        paymentContext(request.log),
      );
      switch (outcome.status) {
        case 'no_hold':
          await reply.status(404).send({
            error: 'No pre-authorized payment for this session',
            code: 'NO_PRE_AUTH',
          });
          return;
        case 'missing_payment_id':
          await reply.status(400).send({
            error: 'Payment intent missing',
            code: 'MISSING_PAYMENT_INTENT',
          });
          return;
        case 'not_configured':
          await reply.status(400).send({
            error: 'No payment provider configured',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        default:
          return outcome.record;
      }
    },
  );

  app.post(
    '/sessions/:id/refund',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Refund a captured payment for a session',
        description:
          'Refunds the payment record for the session through the provider it was made with. Supports partial refunds via amountCents; defaults to a full refund of the remaining captured balance. Validates that the requested refund does not exceed the unrefunded captured amount (refunds still pending at the provider count as refunded). Locks the payment record row with SELECT FOR UPDATE so a concurrent capture or refund cannot interleave. refundStatus is succeeded when the refund is done, or pending when an asynchronous provider (Adyen) confirms it later by webhook; the driver is notified when it is done. Returns 409 REFUND_EXCEEDS_REMAINING when the requested amount is greater than what is still refundable, 409 REFUND_TOP_UP_UNKNOWN when the refund reaches a top-up charge with no recorded payment id (a retry top-up made before v0.1.37), and 409 PAYMENT_OPERATION_PENDING while the provider has not confirmed the capture.',
        operationId: 'refundSessionPayment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        body: zodSchema(refundBody),
        response: {
          200: itemResponse(refundResponseItem),
          400: errorWith('Bad request', [
            ERROR_CODES.MISSING_PAYMENT_INTENT,
            ERROR_CODES.NO_CAPTURED_PAYMENT,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          404: errorWith('Payment not found', [ERROR_CODES.PAYMENT_NOT_FOUND]),
          409: errorWith(
            'Refund exceeds remaining, reaches an unrecorded top-up, or the capture is not confirmed yet',
            [
              ERROR_CODES.REFUND_EXCEEDS_REMAINING,
              ERROR_CODES.REFUND_TOP_UP_UNKNOWN,
              ERROR_CODES.PAYMENT_OPERATION_PENDING,
            ],
          ),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionIdParams>;
      const body = request.body as z.infer<typeof refundBody>;
      const { userId } = request.user as JwtPayload;

      // Site access first, before any payment-state answer: otherwise an
      // operator without access could probe a restricted site's sessions
      // through the response codes.
      const [station] = await db
        .select({ siteId: chargingStations.siteId })
        .from(chargingStations)
        .innerJoin(chargingSessions, eq(chargingSessions.stationId, chargingStations.id))
        .where(eq(chargingSessions.id, id));
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && station?.siteId != null && !siteIds.includes(station.siteId)) {
        await reply.status(404).send({ error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
        return;
      }

      // The record is locked for the refund, and the request key
      // refund_<paymentId>_<refundedSoFar>_<amount>_<ledger> makes a retry reuse the refund
      // while a later partial refund gets its own (P7).
      const outcome = await refundPaymentRecord(
        {
          sessionId: id,
          ...(body.amountCents != null ? { amountCents: body.amountCents } : {}),
          actorUserId: userId,
          actionReason: (full) => body.reason ?? (full ? 'Full refund' : 'Partial refund'),
        },
        paymentContext(request.log),
      );
      if (outcome.status !== 'refunded') {
        await sendRefundRefusal(reply, outcome);
        return;
      }
      const updated = outcome.record;
      const refundedNowCents = outcome.refundedNowCents;

      // Driver notification: payment refunded. Fire-and-forget so a slow
      // SMTP/Twilio call does not delay the response; a failure is logged.
      // A pending refund notifies when the provider confirms it (webhook).
      if (updated.driverId != null && outcome.refundStatus === 'succeeded') {
        dispatchDriverNotification(
          client,
          'payment.Refunded',
          updated.driverId,
          {
            amountCents: refundedNowCents,
            amountFormatted: notificationMoney(refundedNowCents, updated.currency),
            currency: updated.currency,
            transactionId: updated.sessionId,
          },
          ALL_TEMPLATES_DIRS,
          getPubSub(),
        ).catch((err: unknown) => {
          request.log.warn(
            { err, paymentRecordId: updated.id, driverId: updated.driverId },
            'Failed to dispatch payment.Refunded notification',
          );
        });
      }

      return { ...updated, refundStatus: outcome.refundStatus };
    },
  );

  // ---- Reservation fee payments ----

  /**
   * Whether the operator may see the reservation's payments: the reservation
   * exists and its station's site is one the operator has access to.
   */
  async function reservationAccessible(userId: string, reservationId: string): Promise<boolean> {
    const [row] = await db
      .select({ siteId: chargingStations.siteId })
      .from(reservations)
      .innerJoin(chargingStations, eq(chargingStations.id, reservations.stationId))
      .where(eq(reservations.id, reservationId));
    if (row == null) return false;
    const siteIds = await getUserSiteIds(userId);
    return siteIds == null || row.siteId == null || siteIds.includes(row.siteId);
  }

  app.get(
    '/reservations/:id/fee-payments',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'List the fee payments of a reservation',
        description:
          'Returns the cancellation and no-show fee payment records of the reservation, oldest first, with their refund ledger. Empty when no fee was charged.',
        operationId: 'listReservationFeePayments',
        security: [{ bearerAuth: [] }],
        params: zodSchema(reservationIdParams),
        response: {
          200: arrayResponse(feePaymentItem),
          404: errorWith('Reservation not found', [ERROR_CODES.RESERVATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof reservationIdParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await reservationAccessible(userId, id))) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }
      return db
        .select()
        .from(paymentRecords)
        .where(
          and(
            eq(paymentRecords.reservationId, id),
            inArray(paymentRecords.chargeType, [...RESERVATION_FEE_CHARGE_TYPES]),
          ),
        )
        .orderBy(paymentRecords.createdAt, paymentRecords.id);
    },
  );

  app.post(
    '/reservations/:id/fee-payments/:paymentId/refund',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Refund a reservation fee payment',
        description:
          'Refunds a cancellation or no-show fee of the reservation through the provider it was charged with, with the rules of a session refund: partial refunds via amountCents (default: everything still refundable), refunds still pending at the provider count as refunded, the payment record row is locked, and the idempotency key refund_<paymentId>_<refundedSoFar>_<amount>_<ledgerEntries> makes a retry reuse the provider refund. refundStatus is pending when an asynchronous provider (Adyen) confirms the refund later by webhook; the driver is notified (payment.FeeRefunded) when it is done. Returns 404 PAYMENT_NOT_FOUND when the payment is not a fee of this reservation, 409 REFUND_EXCEEDS_REMAINING when the amount is greater than what is still refundable, and 409 PAYMENT_OPERATION_PENDING while the provider has not confirmed an operation.',
        operationId: 'refundReservationFeePayment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(feePaymentParams),
        body: zodSchema(refundBody),
        response: {
          200: itemResponse(feeRefundResponseItem),
          400: errorWith('Bad request', [
            ERROR_CODES.MISSING_PAYMENT_INTENT,
            ERROR_CODES.NO_CAPTURED_PAYMENT,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          404: errorWith('Payment not found', [ERROR_CODES.PAYMENT_NOT_FOUND]),
          409: errorWith('Refund exceeds remaining, or an operation is not confirmed yet', [
            ERROR_CODES.REFUND_EXCEEDS_REMAINING,
            ERROR_CODES.REFUND_TOP_UP_UNKNOWN,
            ERROR_CODES.PAYMENT_OPERATION_PENDING,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, paymentId } = request.params as z.infer<typeof feePaymentParams>;
      const body = request.body as z.infer<typeof refundBody>;
      const { userId } = request.user as JwtPayload;

      // Site access and ownership first, before any payment-state answer, so
      // an operator cannot probe other sites' payments through the codes.
      const [fee] = await db
        .select({ id: paymentRecords.id })
        .from(paymentRecords)
        .where(and(eq(paymentRecords.id, paymentId), eq(paymentRecords.reservationId, id)));
      if (fee == null || !(await reservationAccessible(userId, id))) {
        await reply.status(404).send({ error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
        return;
      }

      // The session refund's path: record locked, key over the refunded total (P7).
      const outcome = await refundPaymentRecord(
        {
          feeRecordId: paymentId,
          ...(body.amountCents != null ? { amountCents: body.amountCents } : {}),
          actorUserId: userId,
          actionReason: (full) => body.reason ?? (full ? 'Full refund' : 'Partial refund'),
        },
        paymentContext(request.log),
      );
      if (outcome.status !== 'refunded') {
        await sendRefundRefusal(reply, outcome);
        return;
      }
      // Driver notification (payment.FeeRefunded), fire-and-forget like the
      // session refund. A pending refund notifies when the provider confirms it
      // (webhook notice), so each refund notifies once.
      if (outcome.refundStatus === 'succeeded') {
        const record = outcome.record;
        dispatchFeeRefundNotification(record, outcome.refundedNowCents, {
          templatesDirs: ALL_TEMPLATES_DIRS,
          pubsub: getPubSub(),
        }).catch((err: unknown) => {
          request.log.warn(
            { err, paymentRecordId: record.id, driverId: record.driverId },
            'Failed to dispatch payment.FeeRefunded notification',
          );
        });
      }
      return { ...outcome.record, refundStatus: outcome.refundStatus };
    },
  );

  app.get(
    '/sessions/:id/payment',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'Get payment record for a session',
        operationId: 'getSessionPayment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        response: {
          200: itemResponse(paymentRecordItem),
          404: errorWith('Payment not found', [ERROR_CODES.PAYMENT_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionIdParams>;
      const { userId } = request.user as JwtPayload;

      const [sessionRow] = await db
        .select({ siteId: chargingStations.siteId })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
        .where(eq(chargingSessions.id, id));

      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && sessionRow?.siteId != null && !siteIds.includes(sessionRow.siteId)) {
        await reply.status(404).send({
          error: 'No payment record for this session',
          code: 'PAYMENT_NOT_FOUND',
        });
        return;
      }

      const [record] = await db
        .select()
        .from(paymentRecords)
        .where(eq(paymentRecords.sessionId, id));

      if (record == null) {
        await reply.status(404).send({
          error: 'No payment record for this session',
          code: 'PAYMENT_NOT_FOUND',
        });
        return;
      }
      return record;
    },
  );

  app.post(
    '/payments/:id/retry-capture',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Retry capture or top-up for a payment record',
        description:
          'Re-attempts capture for a payment record where the final cost exceeded the pre-auth and the top-up PaymentIntent previously failed (status=captured AND captured_amount_cents < session.final_cost_cents). Creates a new PaymentIntent for the unpaid delta and captures it. Returns 409 PAYMENT_RECORD_NOT_RECOVERABLE when the record has no shortfall or is in an unsupported state.',
        operationId: 'retryPaymentCapture',
        security: [{ bearerAuth: [] }],
        params: zodSchema(z.object({ id: z.coerce.number().int().min(1) })),
        response: {
          200: itemResponse(paymentRecordItem),
          404: errorWith('Payment not found', [ERROR_CODES.PAYMENT_NOT_FOUND]),
          409: errorWith('Payment record cannot be recovered or Stripe not configured', [
            ERROR_CODES.PAYMENT_RECORD_NOT_RECOVERABLE,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          502: errorWith('Stripe rejected the top-up payment intent', [
            ERROR_CODES.PAYMENT_TOP_UP_FAILED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const { userId } = request.user as JwtPayload;

      // Site access: operators with restricted site access can only retry
      // payments of sessions on their sites.
      const [row] = await db
        .select({ siteId: chargingStations.siteId })
        .from(paymentRecords)
        .innerJoin(chargingSessions, eq(chargingSessions.id, paymentRecords.sessionId))
        .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
        .where(eq(paymentRecords.id, id));
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && row?.siteId != null && !siteIds.includes(row.siteId)) {
        await reply.status(404).send({ error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
        return;
      }

      // Same card and payout account, the platform fee of the increment, key
      // topup_retry_<paymentId>_<captured> shared with the daily retry.
      const outcome = await retryShortfallForRecord(
        { recordId: id, actorUserId: userId },
        paymentContext(request.log),
      );
      switch (outcome.status) {
        case 'not_found':
          await reply.status(404).send({ error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
          return;
        case 'not_recoverable':
          await reply.status(409).send({
            error: outcome.reason,
            code: 'PAYMENT_RECORD_NOT_RECOVERABLE',
          });
          return;
        case 'not_configured':
          await reply.status(409).send({
            error: 'Payment provider not configured',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        case 'failed':
          await reply.status(502).send({
            error: `The payment provider rejected the top-up: ${outcome.reason}`,
            code: 'PAYMENT_TOP_UP_FAILED',
          });
          return;
        case 'recovered':
          return outcome.record;
      }
    },
  );

  // ---- Reconciliation ----

  app.get(
    '/payments/reconciliation',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'List payment reconciliation runs',
        operationId: 'listReconciliationRuns',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(reconciliationRunItem) },
      },
    },
    async (request) => {
      const { page, limit } = request.query as z.infer<typeof paginationQuery>;
      const offset = (page - 1) * limit;

      const [data, countRows] = await Promise.all([
        db
          .select()
          .from(paymentReconciliationRuns)
          .orderBy(desc(paymentReconciliationRuns.createdAt), desc(paymentReconciliationRuns.id))
          .limit(limit)
          .offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(paymentReconciliationRuns),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  app.post(
    '/payments/reconciliation/run',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Run payment reconciliation against Stripe',
        operationId: 'runReconciliation',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(reconciliationResultItem) },
      },
    },
    async (request) => {
      return runPaymentReconciliation(paymentContext(request.log));
    },
  );

  app.get(
    '/payments',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Payments'],
        summary: 'List all payment records',
        operationId: 'listPayments',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(paymentRecordItem) },
      },
    },
    async (request) => {
      const { page, limit } = request.query as z.infer<typeof paginationQuery>;
      const { userId } = request.user as JwtPayload;
      const offset = (page - 1) * limit;

      // Site-access enforcement: payment records carry sensitive data
      // (Stripe PI IDs, customer IDs, captured amounts) and must be filtered
      // to the operator's allowed sites: a session record through its
      // session's station, a reservation fee through its reservation's.
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) {
        return { data: [], total: 0 } satisfies PaginatedResponse<
          typeof paymentRecords.$inferSelect
        >;
      }

      const whereClause = siteIds != null ? paymentRecordsAtSites(siteIds) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select()
          .from(paymentRecords)
          .where(whereClause)
          .orderBy(desc(paymentRecords.createdAt), desc(paymentRecords.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(paymentRecords)
          .where(whereClause),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );
}
