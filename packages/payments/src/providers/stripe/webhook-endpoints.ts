// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type Stripe from 'stripe';
import { createLogger } from '@evtivity/lib';
import {
  PaymentProviderPermissionError,
  PaymentProviderUnavailableError,
  PaymentValidationError,
  WebhookExistsError,
} from '../../errors.js';
import type {
  WebhookEndpointInfo,
  WebhookRegistration,
  WebhookRegistrationInput,
} from '../../types.js';
import { partitionWebhookEndpoints } from '../../webhook-endpoint-url.js';

const logger = createLogger('stripe-webhook-endpoints');

/**
 * Snapshot event shape of the endpoints EVtivity creates: the API version the
 * `stripe` SDK pins (a unit test checks they match), so webhook payloads and
 * API responses have the same shape.
 */
export const STRIPE_WEBHOOK_API_VERSION = '2026-09-30.endive' satisfies NonNullable<
  Stripe.WebhookEndpointCreateParams['api_version']
>;

/** Events of the platform endpoint: the ones `normalizeStripeEvent` acts on. */
export const STRIPE_PLATFORM_EVENTS = [
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[];

/** Events of the Connect endpoint (connected accounts' own events). */
export const STRIPE_CONNECT_EVENTS = [
  'account.updated',
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[];

/** Metadata key that marks an endpoint EVtivity created, valued 'platform' or 'connect'. */
const EVTIVITY_METADATA_KEY = 'evtivity_scope';

const PROVIDER_ID = 'stripe';

type WebhookEndpointsClient = Pick<Stripe, 'webhookEndpoints'>;

/**
 * A restricted key without the webhook permission becomes
 * PaymentProviderPermissionError, a request Stripe rejects (a URL it cannot
 * reach, Connect not enabled) PaymentValidationError with Stripe's message.
 * Anything else is rethrown for the provider's error translation.
 */
function translate(err: unknown, permission: string): unknown {
  const type = (err as { type?: unknown } | null)?.type;
  if (type === 'StripePermissionError') {
    return new PaymentProviderPermissionError(PROVIDER_ID, permission, { cause: err });
  }
  if (type === 'StripeInvalidRequestError' && err instanceof Error) {
    return new PaymentValidationError(err.message);
  }
  return err;
}

async function request<T>(permission: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw translate(err, permission);
  }
}

function info(endpoint: Stripe.WebhookEndpoint): WebhookEndpointInfo {
  return {
    id: endpoint.id,
    url: endpoint.url,
    scope: endpoint.metadata[EVTIVITY_METADATA_KEY] ?? '',
    enabledEvents: endpoint.enabled_events,
    apiVersion: endpoint.api_version ?? null,
    active: endpoint.status === 'enabled',
  };
}

/**
 * The webhook endpoints EVtivity created (marked with `metadata.evtivity_scope`).
 * Stripe allows 16 endpoints per account, so one page of 100 holds them all.
 */
export async function listEvtivityWebhookEndpoints(
  stripe: WebhookEndpointsClient,
): Promise<WebhookEndpointInfo[]> {
  const page = await request('Webhook Endpoints: read', () =>
    stripe.webhookEndpoints.list({ limit: 100 }),
  );
  return page.data
    .filter((endpoint) => (endpoint.metadata[EVTIVITY_METADATA_KEY] ?? '') !== '')
    .map(info);
}

async function createEndpoint(
  stripe: WebhookEndpointsClient,
  params: Stripe.WebhookEndpointCreateParams,
): Promise<Stripe.WebhookEndpoint & { secret: string }> {
  const endpoint = await request('Webhook Endpoints: write', () =>
    stripe.webhookEndpoints.create(params),
  );
  if (endpoint.secret == null || endpoint.secret === '') {
    throw new PaymentProviderUnavailableError(
      `Stripe created webhook endpoint ${endpoint.id} without a signing secret`,
    );
  }
  return { ...endpoint, secret: endpoint.secret };
}

/**
 * Creates the two endpoints EVtivity needs, each with its own signing secret:
 * the platform endpoint (payment events) and the Connect endpoint
 * (`account.updated` of connected accounts). Only EVtivity endpoints at the
 * requested URL (same origin and path) count as existing: endpoints of other
 * EVtivity deployments on the same Stripe account are never deleted.
 * Existing endpoints at the URL are replaced only with `replace` (Stripe
 * returns a secret only on create, so an existing endpoint cannot be
 * adopted), and deleted only after both new ones exist, so events keep
 * flowing. If the Connect endpoint fails, the new platform endpoint is
 * deleted again: nothing is left half registered. No idempotency key: a
 * retry lists first and finds an earlier attempt's endpoints. The secrets
 * are only in the returned settings.
 */
export async function registerStripeWebhookEndpoints(
  stripe: WebhookEndpointsClient,
  input: WebhookRegistrationInput,
): Promise<WebhookRegistration> {
  const { matching: existing, other } = partitionWebhookEndpoints(
    await listEvtivityWebhookEndpoints(stripe),
    input.url,
  );
  if (existing.length > 0 && !input.replace) {
    throw new WebhookExistsError(PROVIDER_ID, existing, other);
  }

  const platform = await createEndpoint(stripe, {
    url: input.url,
    enabled_events: [...STRIPE_PLATFORM_EVENTS],
    api_version: STRIPE_WEBHOOK_API_VERSION,
    description: 'EVtivity payments',
    metadata: { [EVTIVITY_METADATA_KEY]: 'platform' },
  });

  let connect: Stripe.WebhookEndpoint & { secret: string };
  try {
    connect = await createEndpoint(stripe, {
      url: input.url,
      connect: true,
      enabled_events: [...STRIPE_CONNECT_EVENTS],
      api_version: STRIPE_WEBHOOK_API_VERSION,
      description: 'EVtivity payout accounts (Connect)',
      metadata: { [EVTIVITY_METADATA_KEY]: 'connect' },
    });
  } catch (err) {
    try {
      await stripe.webhookEndpoints.del(platform.id);
    } catch (cleanupErr) {
      const reason = err instanceof Error ? err.message : String(err);
      const cleanup = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      throw new PaymentProviderUnavailableError(
        `Stripe did not create the Connect webhook endpoint (${reason}), and the new platform endpoint ${platform.id} could not be deleted (${cleanup}). Create the webhook again at the same URL with replace to remove it.`,
        { cause: err },
      );
    }
    throw err;
  }

  // An old endpoint at this URL that cannot be deleted stays listed, so the
  // operator sees it.
  const leftOver: WebhookEndpointInfo[] = [];
  for (const old of existing) {
    try {
      await stripe.webhookEndpoints.del(old.id);
    } catch (err) {
      logger.warn(
        { err, endpointId: old.id },
        'Old Stripe webhook endpoint delete failed, it stays listed for the operator',
      );
      leftOver.push(old);
    }
  }

  return {
    endpoints: [info(platform), info(connect), ...leftOver],
    settings: [
      { key: 'stripe.webhookSecretEnc', value: platform.secret, secret: true },
      { key: 'stripe.connectWebhookSecretEnc', value: connect.secret, secret: true },
    ],
  };
}
