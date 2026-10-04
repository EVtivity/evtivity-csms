// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Stripe from 'stripe';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import { StripePaymentProvider } from '../providers/stripe/index.js';
import {
  STRIPE_CONNECT_EVENTS,
  STRIPE_PLATFORM_EVENTS,
  STRIPE_WEBHOOK_API_VERSION,
} from '../providers/stripe/webhook-endpoints.js';
import {
  PaymentProviderPermissionError,
  PaymentProviderUnavailableError,
  PaymentValidationError,
  WebhookExistsError,
} from '../errors.js';
import { FakeStripeError, fakeStripeModule, stripeRecorder } from '../testing/index.js';

const URL = 'https://csms.example.com/v1/webhooks/payments/stripe';

function provider(): StripePaymentProvider {
  const FakeStripe = fakeStripeModule().default;
  return new StripePaymentProvider({
    client: new FakeStripe() as unknown as Stripe,
    publishableKey: 'pk_test_1',
    webhookSecret: null,
    connectWebhookSecret: null,
  });
}

function calls(): string[] {
  return stripeRecorder.calls.map((c) => c.call);
}

const OTHER_DEPLOYMENT_URL = 'https://other.example.com/v1/webhooks/payments/stripe';

/** EVtivity endpoints at `url`; by default this deployment's URL. */
function seedEvtivityEndpoints(url = URL, prefix = 'we_old'): void {
  stripeRecorder.seedWebhookEndpoint({
    id: `${prefix}_platform`,
    url,
    enabled_events: [...STRIPE_PLATFORM_EVENTS],
    metadata: { evtivity_scope: 'platform' },
  });
  stripeRecorder.seedWebhookEndpoint({
    id: `${prefix}_connect`,
    url,
    enabled_events: [...STRIPE_CONNECT_EVENTS],
    metadata: { evtivity_scope: 'connect' },
  });
}

function permissionError(): FakeStripeError {
  return new FakeStripeError(
    'StripePermissionError',
    'The provided key does not have the required permissions for this endpoint',
    { statusCode: 403 },
  );
}

describe('Stripe webhook endpoints', () => {
  beforeEach(() => {
    stripeRecorder.reset();
  });

  it('exports the protocol facts the docs and UI show', () => {
    expect(STRIPE_WEBHOOK_API_VERSION).toBe('2026-09-30.endive');
    // The endpoints send events in the shape of the API version the SDK pins.
    expect(STRIPE_WEBHOOK_API_VERSION).toBe(Stripe.API_VERSION);
    expect(STRIPE_PLATFORM_EVENTS).toEqual([
      'payment_intent.payment_failed',
      'charge.refunded',
      'charge.dispute.created',
    ]);
    expect(STRIPE_CONNECT_EVENTS).toEqual(['account.updated']);
  });

  describe('listWebhooks', () => {
    it('lists only the endpoints EVtivity created', async () => {
      seedEvtivityEndpoints('https://old.example.com/v1/webhooks/payments/stripe');
      stripeRecorder.seedWebhookEndpoint({ id: 'we_foreign', metadata: {} });
      stripeRecorder.seedWebhookEndpoint({
        id: 'we_disabled',
        status: 'disabled',
        api_version: '2026-09-30.endive',
        metadata: { evtivity_scope: 'platform' },
      });

      const endpoints = await provider().listWebhooks();

      expect(endpoints).toEqual([
        {
          id: 'we_old_platform',
          url: 'https://old.example.com/v1/webhooks/payments/stripe',
          scope: 'platform',
          enabledEvents: [...STRIPE_PLATFORM_EVENTS],
          apiVersion: null,
          active: true,
        },
        {
          id: 'we_old_connect',
          url: 'https://old.example.com/v1/webhooks/payments/stripe',
          scope: 'connect',
          enabledEvents: [...STRIPE_CONNECT_EVENTS],
          apiVersion: null,
          active: true,
        },
        {
          id: 'we_disabled',
          url: 'https://seeded.example.com/v1/webhooks/payments/stripe',
          scope: 'platform',
          enabledEvents: ['*'],
          apiVersion: '2026-09-30.endive',
          active: false,
        },
      ]);
      expect(stripeRecorder.calls).toEqual([
        { call: 'webhookEndpoints.list', args: [{ limit: 100 }] },
      ]);
    });

    it('reports a key without webhook read access as a missing permission', async () => {
      stripeRecorder.callFailures.set('webhookEndpoints.list', [permissionError()]);
      const err = await provider()
        .listWebhooks()
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PaymentProviderPermissionError);
      expect((err as PaymentProviderPermissionError).permission).toBe('Webhook Endpoints: read');
    });
  });

  describe('registerWebhook', () => {
    it('creates the platform and the Connect endpoint and returns both secrets', async () => {
      const result = await provider().registerWebhook({ url: URL, replace: false });

      expect(stripeRecorder.calls).toEqual([
        { call: 'webhookEndpoints.list', args: [{ limit: 100 }] },
        {
          call: 'webhookEndpoints.create',
          args: [
            {
              url: URL,
              enabled_events: [...STRIPE_PLATFORM_EVENTS],
              api_version: '2026-09-30.endive',
              description: 'EVtivity payments',
              metadata: { evtivity_scope: 'platform' },
            },
          ],
        },
        {
          call: 'webhookEndpoints.create',
          args: [
            {
              url: URL,
              connect: true,
              enabled_events: [...STRIPE_CONNECT_EVENTS],
              api_version: '2026-09-30.endive',
              description: 'EVtivity payout accounts (Connect)',
              metadata: { evtivity_scope: 'connect' },
            },
          ],
        },
      ]);
      expect(result.settings).toEqual([
        { key: 'stripe.webhookSecretEnc', value: 'whsec_we_fake_1', secret: true },
        { key: 'stripe.connectWebhookSecretEnc', value: 'whsec_we_fake_2', secret: true },
      ]);
      expect(result.endpoints).toEqual([
        {
          id: 'we_fake_1',
          url: URL,
          scope: 'platform',
          enabledEvents: [...STRIPE_PLATFORM_EVENTS],
          apiVersion: '2026-09-30.endive',
          active: true,
        },
        {
          id: 'we_fake_2',
          url: URL,
          scope: 'connect',
          enabledEvents: [...STRIPE_CONNECT_EVENTS],
          apiVersion: '2026-09-30.endive',
          active: true,
        },
      ]);
      // Secrets travel only in `settings`, never in the endpoint list.
      expect(JSON.stringify(result.endpoints)).not.toContain('whsec_');
    });

    it('refuses to replace existing EVtivity endpoints at the URL without replace', async () => {
      seedEvtivityEndpoints();
      seedEvtivityEndpoints(OTHER_DEPLOYMENT_URL, 'we_other');
      stripeRecorder.seedWebhookEndpoint({ id: 'we_foreign' });

      const err = await provider()
        .registerWebhook({ url: URL, replace: false })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WebhookExistsError);
      expect((err as WebhookExistsError).endpoints.map((e) => e.id)).toEqual([
        'we_old_platform',
        'we_old_connect',
      ]);
      // Other deployments' endpoints are listed apart.
      expect((err as WebhookExistsError).otherEndpoints.map((e) => e.id)).toEqual([
        'we_other_platform',
        'we_other_connect',
      ]);
      expect(calls()).toEqual(['webhookEndpoints.list']);
    });

    it('matches the URL by origin and path, so a different host or port is another deployment', async () => {
      // Same deployment: Stripe may store the default port or another host case.
      seedEvtivityEndpoints('https://CSMS.example.com:443/v1/webhooks/payments/stripe');
      const err = await provider()
        .registerWebhook({ url: URL, replace: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WebhookExistsError);

      stripeRecorder.reset();
      seedEvtivityEndpoints('https://csms.example.com:8443/v1/webhooks/payments/stripe');
      await expect(provider().registerWebhook({ url: URL, replace: false })).resolves.toBeDefined();
    });

    it("creates its endpoints next to another deployment's without touching them", async () => {
      seedEvtivityEndpoints(OTHER_DEPLOYMENT_URL, 'we_other');

      const result = await provider().registerWebhook({ url: URL, replace: false });

      expect(calls()).toEqual([
        'webhookEndpoints.list',
        'webhookEndpoints.create',
        'webhookEndpoints.create',
      ]);
      expect([...stripeRecorder.webhookEndpoints.keys()].sort()).toEqual([
        'we_fake_1',
        'we_fake_2',
        'we_other_connect',
        'we_other_platform',
      ]);
      expect(result.endpoints.map((e) => e.id)).toEqual(['we_fake_1', 'we_fake_2']);
    });

    it('with replace creates both new endpoints before deleting the old ones at the URL', async () => {
      seedEvtivityEndpoints();
      seedEvtivityEndpoints(OTHER_DEPLOYMENT_URL, 'we_other');
      stripeRecorder.seedWebhookEndpoint({ id: 'we_foreign' });

      const result = await provider().registerWebhook({ url: URL, replace: true });

      expect(calls()).toEqual([
        'webhookEndpoints.list',
        'webhookEndpoints.create',
        'webhookEndpoints.create',
        'webhookEndpoints.del',
        'webhookEndpoints.del',
      ]);
      expect(stripeRecorder.calls.slice(3).map((c) => c.args[0])).toEqual([
        'we_old_platform',
        'we_old_connect',
      ]);
      // An endpoint EVtivity did not create, and another deployment's, are left alone.
      expect([...stripeRecorder.webhookEndpoints.keys()].sort()).toEqual([
        'we_fake_1',
        'we_fake_2',
        'we_foreign',
        'we_other_connect',
        'we_other_platform',
      ]);
      expect(result.endpoints.map((e) => e.id)).toEqual(['we_fake_1', 'we_fake_2']);
    });

    it('reports an old endpoint it could not delete in the endpoint list', async () => {
      seedEvtivityEndpoints();
      stripeRecorder.callFailures.set('webhookEndpoints.del', [
        new FakeStripeError('StripeAPIError', 'Stripe had a problem'),
      ]);

      const result = await provider().registerWebhook({ url: URL, replace: true });

      expect(result.endpoints.map((e) => e.id)).toEqual([
        'we_fake_1',
        'we_fake_2',
        'we_old_platform',
      ]);
      expect(result.settings).toHaveLength(2);
    });

    it('deletes the platform endpoint when the Connect endpoint cannot be created', async () => {
      seedEvtivityEndpoints();
      stripeRecorder.callFailures.set('webhookEndpoints.create', [
        null,
        new FakeStripeError('StripeInvalidRequestError', 'Connect is not enabled', {
          statusCode: 400,
        }),
      ]);

      const err = await provider()
        .registerWebhook({ url: URL, replace: true })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PaymentValidationError);
      expect((err as Error).message).toBe('Connect is not enabled');
      expect(calls()).toEqual([
        'webhookEndpoints.list',
        'webhookEndpoints.create',
        'webhookEndpoints.create',
        'webhookEndpoints.del',
      ]);
      expect(stripeRecorder.calls[3]?.args).toEqual(['we_fake_1']);
      // The old endpoints still deliver events.
      expect([...stripeRecorder.webhookEndpoints.keys()].sort()).toEqual([
        'we_old_connect',
        'we_old_platform',
      ]);
    });

    it('names the endpoint left behind when its cleanup fails too', async () => {
      stripeRecorder.callFailures.set('webhookEndpoints.create', [
        null,
        new FakeStripeError('StripeAPIError', 'Stripe had a problem'),
      ]);
      stripeRecorder.callFailures.set('webhookEndpoints.del', [
        new FakeStripeError('StripeConnectionError', 'Network down'),
      ]);

      const err = await provider()
        .registerWebhook({ url: URL, replace: false })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PaymentProviderUnavailableError);
      expect((err as Error).message).toContain('we_fake_1');
      expect((err as Error).message).toContain('replace');
    });

    it('turns a rejected URL into a validation error with the Stripe message', async () => {
      stripeRecorder.callFailures.set('webhookEndpoints.create', [
        new FakeStripeError(
          'StripeInvalidRequestError',
          'Invalid URL: must be publicly accessible',
          {
            statusCode: 400,
          },
        ),
      ]);

      const err = await provider()
        .registerWebhook({ url: URL, replace: false })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PaymentValidationError);
      expect((err as Error).message).toBe('Invalid URL: must be publicly accessible');
      expect(calls()).toEqual(['webhookEndpoints.list', 'webhookEndpoints.create']);
    });

    it('reports a restricted key without webhook write access as a missing permission', async () => {
      stripeRecorder.callFailures.set('webhookEndpoints.create', [permissionError()]);

      const err = await provider()
        .registerWebhook({ url: URL, replace: false })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PaymentProviderPermissionError);
      expect((err as PaymentProviderPermissionError).permission).toBe('Webhook Endpoints: write');
      expect((err as PaymentProviderPermissionError).providerId).toBe('stripe');
    });

    it('never sends or records a secret', async () => {
      seedEvtivityEndpoints();
      await provider().registerWebhook({ url: URL, replace: true });
      expect(JSON.stringify(stripeRecorder.calls)).not.toContain('whsec_');
    });
  });
});
