// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Webhook contract test of StripePaymentProvider against real Stripe test
// mode (plan P3.5 Part F, task F1). Runs only when STRIPE_TEST_SECRET_KEY
// holds a test-mode key (sk_test_ or rk_test_); CI has none, so it is skipped
// there. The delivery block also needs the Stripe CLI (`stripe` on PATH, or
// STRIPE_CLI with its path) and is skipped without it. Never log or commit
// the key or a signing secret.
//
// Registration: a registration acts only on the EVtivity endpoints (metadata
// `evtivity_scope`) at its own URL (origin and path). The test refuses to run
// when the account already has one at the test URL, creates an EVtivity
// endpoint pair at another URL to stand for another deployment sharing the
// account, proves registration and replace never touch it, and deletes only
// the endpoints it created. Endpoints of real deployments on the account are
// left alone.
//
// Delivery: `stripe listen` forwards the account's own events and its
// connected accounts' events to a local HTTP server, signed with the CLI's
// secret. A real refund (platform event) and a real update of a connected
// account the test creates (Connect event) must verify and normalize, the
// Connect one through the second (Connect) secret.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Stripe from 'stripe';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import { StripePaymentProvider } from '../providers/stripe/index.js';
import {
  STRIPE_CONNECT_EVENTS,
  STRIPE_PLATFORM_EVENTS,
  STRIPE_WEBHOOK_API_VERSION,
} from '../providers/stripe/webhook-endpoints.js';
import { WebhookExistsError, WebhookSignatureError } from '../errors.js';
import type { NormalizedPaymentEvent, WebhookRegistration } from '../types.js';
import { partitionWebhookEndpoints } from '../webhook-endpoint-url.js';

const secretKey = process.env['STRIPE_TEST_SECRET_KEY'] ?? '';
const isTestKey = /^(sk|rk)_test_/.test(secretKey);
const stripeCli = process.env['STRIPE_CLI'] ?? 'stripe';
const hasCli =
  isTestKey && spawnSync(stripeCli, ['version'], { stdio: 'ignore', timeout: 10_000 }).status === 0;

/** Resolvable host: Stripe validates the URL, it never reaches this path during the test. */
const TEST_URL = `https://example.com/v1/webhooks/payments/stripe?evtivity_live_test=${crypto.randomBytes(4).toString('hex')}`;
/** Another EVtivity deployment on the same Stripe account. */
const OTHER_DEPLOYMENT_URL = `https://example.org/v1/webhooks/payments/stripe?evtivity_live_test=${crypto.randomBytes(4).toString('hex')}`;
const METADATA_PURPOSE = 'evtivity-p3.5-webhook-live-test';

function provider(
  client: Stripe,
  webhookSecret: string | null,
  connectWebhookSecret: string | null,
): StripePaymentProvider {
  return new StripePaymentProvider({
    client,
    publishableKey: 'pk_test_unused',
    webhookSecret,
    connectWebhookSecret,
  });
}

describe.skipIf(!isTestKey)('Stripe webhook registration against Stripe test mode', () => {
  let client: Stripe;
  let stripe: StripePaymentProvider;
  const createdIds = new Set<string>();

  function remember(registration: WebhookRegistration): void {
    for (const endpoint of registration.endpoints) createdIds.add(endpoint.id);
  }

  /** The EVtivity endpoints at the test URL. */
  async function atTestUrl(): Promise<string[]> {
    const { matching } = partitionWebhookEndpoints(await stripe.listWebhooks(), TEST_URL);
    return matching.map((e) => e.id).sort();
  }

  beforeAll(async () => {
    client = new Stripe(secretKey, { maxNetworkRetries: 3 });
    stripe = provider(client, null, null);
    const existing = await atTestUrl();
    if (existing.length > 0) {
      throw new Error(
        `The Stripe account already has ${String(existing.length)} EVtivity webhook endpoint(s) at the test URL. ` +
          'A registration with replace deletes them, so this test does not run here.',
      );
    }
  }, 60_000);

  afterAll(async () => {
    // Only endpoints this run created: marked by EVtivity and on a test URL.
    const page = await client.webhookEndpoints.list({ limit: 100 });
    for (const endpoint of page.data) {
      const ours =
        createdIds.has(endpoint.id) ||
        ((endpoint.metadata['evtivity_scope'] ?? '') !== '' &&
          (endpoint.url === TEST_URL || endpoint.url === OTHER_DEPLOYMENT_URL));
      if (ours) await client.webhookEndpoints.del(endpoint.id);
    }
  }, 60_000);

  it('creates the platform and Connect endpoints, refuses a second registration, and replaces them', async () => {
    // Another deployment's EVtivity endpoints on the same account.
    const otherIds: string[] = [];
    for (const scope of ['platform', 'connect'] as const) {
      const other = await client.webhookEndpoints.create({
        url: OTHER_DEPLOYMENT_URL,
        enabled_events:
          scope === 'platform' ? [...STRIPE_PLATFORM_EVENTS] : [...STRIPE_CONNECT_EVENTS],
        ...(scope === 'connect' ? { connect: true } : {}),
        description: 'EVtivity webhook live test (other deployment)',
        metadata: { evtivity_scope: scope },
      });
      createdIds.add(other.id);
      otherIds.push(other.id);
    }
    otherIds.sort();

    // The other deployment's endpoints do not block this deployment's registration.
    const first = await stripe.registerWebhook({ url: TEST_URL, replace: false });
    remember(first);
    expect(first.endpoints).toHaveLength(2);
    const [platform, connect] = first.endpoints;
    expect(platform).toMatchObject({
      url: TEST_URL,
      scope: 'platform',
      apiVersion: STRIPE_WEBHOOK_API_VERSION,
      active: true,
    });
    expect([...(platform?.enabledEvents ?? [])].sort()).toEqual([...STRIPE_PLATFORM_EVENTS].sort());
    expect(connect).toMatchObject({
      url: TEST_URL,
      scope: 'connect',
      apiVersion: STRIPE_WEBHOOK_API_VERSION,
      active: true,
    });
    expect(connect?.enabledEvents).toEqual([...STRIPE_CONNECT_EVENTS]);

    // Stripe stores the marker EVtivity lists its endpoints by.
    const platformRead = await client.webhookEndpoints.retrieve(platform?.id ?? '');
    const connectRead = await client.webhookEndpoints.retrieve(connect?.id ?? '');
    expect(connectRead.metadata).toEqual({ evtivity_scope: 'connect' });
    expect(platformRead.metadata).toEqual({ evtivity_scope: 'platform' });

    // Two secrets, different, Stripe's format (only the prefix is asserted).
    const secrets = new Map(first.settings.map((s) => [s.key, s]));
    const platformSecret = secrets.get('stripe.webhookSecretEnc');
    const connectSecret = secrets.get('stripe.connectWebhookSecretEnc');
    expect(platformSecret?.secret).toBe(true);
    expect(connectSecret?.secret).toBe(true);
    expect(String(platformSecret?.value).startsWith('whsec_')).toBe(true);
    expect(String(connectSecret?.value).startsWith('whsec_')).toBe(true);
    expect(platformSecret?.value).not.toBe(connectSecret?.value);

    expect(await atTestUrl()).toEqual(first.endpoints.map((e) => e.id).sort());

    // Without replace, an existing registration at the URL is reported, not touched.
    const refused = await stripe.registerWebhook({ url: TEST_URL, replace: false }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(WebhookExistsError);
    expect((refused as WebhookExistsError).endpoints.map((e) => e.id).sort()).toEqual(
      first.endpoints.map((e) => e.id).sort(),
    );
    const otherListed = (refused as WebhookExistsError).otherEndpoints.map((e) => e.id);
    for (const id of otherIds) expect(otherListed).toContain(id);
    expect(await atTestUrl()).toEqual(first.endpoints.map((e) => e.id).sort());

    // With replace: two new endpoints, the old ones deleted after both exist.
    const second = await stripe.registerWebhook({ url: TEST_URL, replace: true });
    remember(second);
    expect(second.endpoints).toHaveLength(2);
    expect(second.endpoints.map((e) => e.scope)).toEqual(['platform', 'connect']);
    const after = await stripe.listWebhooks();
    expect(await atTestUrl()).toEqual(second.endpoints.map((e) => e.id).sort());
    for (const old of first.endpoints) expect(after.some((e) => e.id === old.id)).toBe(false);
    // The other deployment's endpoints survive the replace.
    for (const id of otherIds) expect(after.some((e) => e.id === id)).toBe(true);
    const newSecret = second.settings.find((s) => s.key === 'stripe.webhookSecretEnc')?.value;
    expect(newSecret).not.toBe(platformSecret?.value);
  }, 120_000);
});

interface Delivery {
  via: string;
  rawBody: string;
  headers: Record<string, string | undefined>;
}

describe.skipIf(!hasCli)('Stripe webhook delivery through stripe listen', () => {
  let client: Stripe;
  let server: http.Server | null = null;
  let listen: ChildProcess | null = null;
  let cliSecret = '';
  const deliveries: Delivery[] = [];
  const accountIds: string[] = [];

  /** Waits for a delivery whose verified event matches. */
  async function waitFor(
    verify: (d: Delivery) => NormalizedPaymentEvent | null,
    timeoutMs = 90_000,
  ): Promise<{ delivery: Delivery; event: NormalizedPaymentEvent }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const delivery of deliveries) {
        const event = verify(delivery);
        if (event != null) return { delivery, event };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('No matching webhook delivery arrived');
  }

  beforeAll(async () => {
    client = new Stripe(secretKey, { maxNetworkRetries: 3 });
    const env = { ...process.env, STRIPE_API_KEY: secretKey };
    const printed = spawnSync(stripeCli, ['listen', '--print-secret', '--skip-update'], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    cliSecret = /whsec_[A-Za-z0-9]+/.exec(printed.stdout)?.[0] ?? '';
    if (cliSecret === '') throw new Error('stripe listen --print-secret gave no secret');

    const local = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          headers[name] = Array.isArray(value) ? value.join(',') : value;
        }
        const via = new URL(req.url ?? '/', 'http://localhost').searchParams.get('via') ?? '';
        deliveries.push({ via, rawBody: Buffer.concat(chunks).toString('utf8'), headers });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"received":true}');
      });
    });
    server = local;
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    const port = (local.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${String(port)}/v1/webhooks/payments/stripe`;

    const child = spawn(
      stripeCli,
      [
        'listen',
        '--skip-update',
        '--events',
        [...STRIPE_PLATFORM_EVENTS, ...STRIPE_CONNECT_EVENTS].join(','),
        '--forward-to',
        `${base}?via=platform`,
        '--forward-connect-to',
        `${base}?via=connect`,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    listen = child;
    // The CLI prints "Ready!" (with its secret, never logged) once connected.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stripe listen did not get ready')), 60_000);
      const onData = (chunk: Buffer): void => {
        if (chunk.toString('utf8').includes('Ready!')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`stripe listen exited with ${String(code)}`));
      });
    });
  }, 120_000);

  afterAll(async () => {
    listen?.kill('SIGTERM');
    const running = server;
    if (running != null) await new Promise<void>((resolve) => running.close(() => resolve()));
    for (const id of accountIds) {
      try {
        await client.accounts.del(id);
      } catch (err) {
        throw new Error(
          `Could not delete the test connected account created by this run: ${(err as Error).message}`,
        );
      }
    }
  }, 60_000);

  it('verifies and normalizes a real charge.refunded through the platform secret', async () => {
    const intent = await client.paymentIntents.create({
      amount: 500,
      currency: 'usd',
      payment_method: 'pm_card_visa',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      confirm: true,
      description: 'EVtivity webhook live test',
    });
    expect(intent.status).toBe('succeeded');
    await client.refunds.create({ payment_intent: intent.id, amount: 200 });

    // Platform secret only: a body signed with any other secret fails.
    const platformOnly = provider(client, cliSecret, null);
    const { delivery, event } = await waitFor((d) => {
      if (d.via !== 'platform') return null;
      const [normalized] = platformOnly.verifyWebhook(d.rawBody, d.headers);
      return normalized?.type === 'payment.refunded' && normalized.paymentId === intent.id
        ? normalized
        : null;
    });
    expect(event).toMatchObject({
      type: 'payment.refunded',
      paymentId: intent.id,
      refundId: null,
      amountCents: null,
      cumulativeRefundedCents: 200,
      capturedCents: 500,
      providerType: 'charge.refunded',
    });
    expect(event.eventId).toMatch(/^evt_/);

    const wrong = provider(client, 'whsec_not_the_cli_secret', null);
    expect(() => wrong.verifyWebhook(delivery.rawBody, delivery.headers)).toThrow(
      WebhookSignatureError,
    );
  }, 120_000);

  it("verifies and normalizes a connected account's account.updated through the Connect secret", async () => {
    const account = await client.v2.core.accounts.create({
      display_name: 'EVtivity webhook live test',
      contact_email: 'webhook-live-test@example.com',
      dashboard: 'express',
      identity: { country: 'us' },
      configuration: {
        merchant: { capabilities: { card_payments: { requested: true } } },
        recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
      },
      defaults: {
        responsibilities: { fees_collector: 'application', losses_collector: 'application' },
      },
      metadata: { purpose: METADATA_PURPOSE },
    });
    accountIds.push(account.id);
    await client.accounts.update(account.id, {
      metadata: { purpose: METADATA_PURPOSE, touched: 'yes' },
    });

    // The CLI secret as the Connect secret, a different platform secret: the
    // provider must fall back to the second secret.
    const connectSecretOnly = provider(client, 'whsec_not_the_cli_secret', cliSecret);
    const { delivery, event } = await waitFor((d) => {
      if (d.via !== 'connect') return null;
      const [normalized] = connectSecretOnly.verifyWebhook(d.rawBody, d.headers);
      return normalized?.type === 'payout_account.updated' && normalized.accountId === account.id
        ? normalized
        : null;
    });
    expect(event).toMatchObject({
      type: 'payout_account.updated',
      accountId: account.id,
      providerType: 'account.updated',
    });
    expect(event.eventId).toMatch(/^evt_/);
    expect((JSON.parse(delivery.rawBody) as { account?: string }).account).toBe(account.id);
  }, 120_000);
});
