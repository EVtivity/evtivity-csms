// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Webhook setup contract test of AdyenPaymentProvider against a real Adyen
// TEST account, Management API v3 (plan P3.5 Part F, task F2). Runs only when
// ADYEN_TEST_API_KEY and ADYEN_TEST_MERCHANT_ACCOUNT are set; CI has neither,
// so it is skipped there. Never log or commit the key, the webhook password or
// the HMAC key.
//
// Registration acts only on the webhooks at its own URL (origin and path):
// replace updates the one there and activation deletes duplicates there. The
// test refuses to run when the merchant account already has an EVtivity
// webhook (description "EVtivity payments") at the URL it uses. It creates an
// EVtivity webhook at another URL to stand for another deployment sharing the
// account, proves registration never touches it, and deletes every webhook it
// creates. Webhooks of real deployments on the account are left alone.
//
// The delivery block also needs ADYEN_TEST_WEBHOOK_URL: a public https URL
// ending in /v1/webhooks/payments/adyen that reaches a running EVtivity API,
// for example a `cloudflared tunnel --url http://localhost:<port>` quick
// tunnel. That API must use the database this test writes to (DATABASE_URL,
// default the local docker Postgres) and the same SETTINGS_ENCRYPTION_KEY.
// The test stores the Adyen credentials and the new webhook settings there
// (the API reads them within its 60 second settings cache), waits until the
// API accepts an event it signs itself, asks Adyen for a test delivery, and
// restores the previous settings at the end.

import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { client, db, settings } from '@evtivity/database';
import { encryptString } from '@evtivity/lib';

import { AdyenPaymentProvider } from '../providers/adyen/index.js';
import type { AdyenProviderOptions } from '../providers/adyen/index.js';
import {
  ADYEN_WEBHOOK_DESCRIPTION,
  ADYEN_WEBHOOK_EVENT_CODES,
  AdyenManagementClient,
  hasAdyenWebhookRole,
} from '../providers/adyen/management.js';
import { WebhookExistsError } from '../errors.js';
import type { WebhookRegistration } from '../types.js';
import { partitionWebhookEndpoints } from '../webhook-endpoint-url.js';
import { basicAuth, signedNotification } from '../testing/fake-adyen.js';

const apiKey = process.env['ADYEN_TEST_API_KEY'] ?? '';
const merchantAccount = process.env['ADYEN_TEST_MERCHANT_ACCOUNT'] ?? '';
const clientKey = process.env['ADYEN_TEST_CLIENT_KEY'] ?? '';
const webhookUrl = process.env['ADYEN_TEST_WEBHOOK_URL'] ?? '';
const encryptionKey = process.env['SETTINGS_ENCRYPTION_KEY'] ?? '';
const enabled = apiKey !== '' && merchantAccount !== '';
const deliveryEnabled =
  enabled &&
  clientKey !== '' &&
  encryptionKey !== '' &&
  /^https:\/\/[^/]+\/v1\/webhooks\/payments\/adyen$/.test(webhookUrl);

/** Resolvable host (Adyen rejects unresolvable URLs); never delivered to during the test. */
const UNREACHABLE_URL = 'https://example.com/v1/webhooks/payments/adyen';
/** Another EVtivity deployment on the same merchant account; never delivered to either. */
const OTHER_DEPLOYMENT_URL = 'https://example.org/v1/webhooks/payments/adyen';

function options(): AdyenProviderOptions {
  return {
    apiKey,
    merchantAccount,
    clientKey: clientKey === '' ? 'test_unused' : clientKey,
    environment: 'test',
    liveUrlPrefix: null,
    liveRegion: 'eu',
    hmacKey: null,
    hmacKeyPrevious: null,
    webhookUsername: null,
    webhookPassword: null,
    authorisationAdjustment: false,
  };
}

/** Refuses to run when the merchant account already has an EVtivity webhook at one of the URLs. */
async function assertNoEvtivityWebhook(
  provider: AdyenPaymentProvider,
  urls: string[],
): Promise<void> {
  const all = await provider.listWebhooks();
  const existing = urls.flatMap((url) => partitionWebhookEndpoints(all, url).matching);
  if (existing.length > 0) {
    throw new Error(
      `The Adyen merchant account already has ${String(existing.length)} EVtivity webhook(s) at the test URL. ` +
        'Registration with replace changes them, so this test does not run here.',
    );
  }
}

function settingValue(registration: WebhookRegistration, key: string): string {
  const value = registration.settings.find((s) => s.key === key)?.value;
  if (typeof value !== 'string') throw new Error(`registration returned no ${key}`);
  return value;
}

describe.skipIf(!enabled)('Adyen webhook registration against an Adyen TEST account', () => {
  let provider: AdyenPaymentProvider;
  let management: AdyenManagementClient;
  const created = new Set<string>();

  beforeAll(async () => {
    provider = new AdyenPaymentProvider(options());
    management = new AdyenManagementClient({ apiKey, merchantAccount, environment: 'test' });
    await assertNoEvtivityWebhook(provider, [UNREACHABLE_URL, OTHER_DEPLOYMENT_URL]);
  }, 60_000);

  afterAll(async () => {
    for (const id of created) await management.deleteWebhook(id);
  }, 60_000);

  it('reports the webhook role of the credential', async () => {
    const info = await provider.getCredentialInfo();
    expect(hasAdyenWebhookRole(info.roles)).toBe(true);
  }, 60_000);

  it('creates the webhook inactive, refuses a second one, updates it in place, and activates it', async () => {
    // Another deployment's EVtivity webhook on the same merchant account.
    const other = await management.createWebhook({
      type: 'standard',
      url: OTHER_DEPLOYMENT_URL,
      active: false,
      communicationFormat: 'json',
      encryptionProtocol: 'TLSv1.3',
      username: `evtivity-${crypto.randomBytes(6).toString('hex')}`,
      password: crypto.randomBytes(24).toString('base64url'),
      description: ADYEN_WEBHOOK_DESCRIPTION,
      additionalSettings: { includeEventCodes: [...ADYEN_WEBHOOK_EVENT_CODES] },
    });
    created.add(other.id);
    // Adyen returns the event codes in no fixed order.
    const snapshot = async (): Promise<unknown> => {
      const w = (await management.listWebhooks()).find((hook) => hook.id === other.id);
      if (w == null) return null;
      return {
        url: w.url,
        description: w.description,
        username: w.username,
        hasPassword: w.hasPassword,
        active: w.active,
        events: [...(w.additionalSettings?.includeEventCodes ?? [])].sort(),
      };
    };
    const otherBefore = await snapshot();
    expect(otherBefore).not.toBeNull();

    // Even with replace, the webhook at another URL is not adopted: a new one is created.
    const first = await provider.registerWebhook({ url: UNREACHABLE_URL, replace: true });
    const [endpoint] = first.endpoints;
    if (endpoint == null) throw new Error('no endpoint');
    created.add(endpoint.id);
    expect(first.endpoints).toHaveLength(1);
    expect(endpoint.id).not.toBe(other.id);
    expect(endpoint).toMatchObject({ url: UNREACHABLE_URL, scope: 'standard', active: false });

    // Adyen holds what EVtivity sent: JSON, TLS 1.3, Basic auth, the event codes.
    const stored = (await management.listWebhooks()).find((w) => w.id === endpoint.id);
    expect(stored).toMatchObject({
      url: UNREACHABLE_URL,
      active: false,
      communicationFormat: 'json',
      description: ADYEN_WEBHOOK_DESCRIPTION,
      username: settingValue(first, 'adyen.webhookUsername'),
      hasPassword: true,
    });
    expect([...(stored?.additionalSettings?.includeEventCodes ?? [])].sort()).toEqual(
      [...ADYEN_WEBHOOK_EVENT_CODES].sort(),
    );
    expect(settingValue(first, 'adyen.hmacKeyEnc')).toMatch(/^[0-9A-F]{64}$/i);
    expect(settingValue(first, 'adyen.webhookPasswordEnc').length).toBeGreaterThanOrEqual(24);

    const refused = await provider.registerWebhook({ url: UNREACHABLE_URL, replace: false }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(WebhookExistsError);
    expect((refused as WebhookExistsError).endpoints.map((e) => e.id)).toEqual([endpoint.id]);
    expect((refused as WebhookExistsError).otherEndpoints.map((e) => e.id)).toContain(other.id);

    // Replace keeps the webhook and its id, with new credentials and HMAC key.
    const second = await provider.registerWebhook({ url: UNREACHABLE_URL, replace: true });
    expect(second.endpoints[0]?.id).toBe(endpoint.id);
    expect(settingValue(second, 'adyen.hmacKeyEnc')).not.toBe(
      settingValue(first, 'adyen.hmacKeyEnc'),
    );
    expect(settingValue(second, 'adyen.webhookUsername')).not.toBe(
      settingValue(first, 'adyen.webhookUsername'),
    );

    await second.activate?.();
    const listed = await provider.listWebhooks();
    expect(partitionWebhookEndpoints(listed, UNREACHABLE_URL).matching).toEqual([
      expect.objectContaining({ id: endpoint.id, active: true }),
    ]);
    // The other deployment's webhook is unchanged: same URL, credentials and state.
    expect(await snapshot()).toEqual(otherBefore);

    // Adyen's test delivery to a URL that answers no 2xx reports a failure.
    const test = await provider.sendTestWebhook(endpoint.id);
    expect(test.status).toBe('failed');
  }, 120_000);
});

describe.skipIf(!deliveryEnabled)('Adyen webhook delivery to a running EVtivity API', () => {
  let provider: AdyenPaymentProvider;
  let management: AdyenManagementClient;
  let webhookId: string | null = null;
  const touchedKeys = [
    'adyen.apiKeyEnc',
    'adyen.merchantAccount',
    'adyen.clientKey',
    'adyen.environment',
    'adyen.webhookUsername',
    'adyen.webhookPasswordEnc',
    'adyen.hmacKeyEnc',
    'adyen.hmacKeyPreviousEnc',
  ];
  let previous: Array<{ key: string; value: unknown }> = [];

  /** Test-only settings writer: the stored values the API's settings reader decrypts. */
  async function storeSettings(pairs: Array<{ key: string; value: unknown }>): Promise<void> {
    await db.transaction(async (tx) => {
      for (const { key, value } of pairs) {
        await tx
          .insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
      }
    });
  }

  beforeAll(async () => {
    provider = new AdyenPaymentProvider(options());
    management = new AdyenManagementClient({ apiKey, merchantAccount, environment: 'test' });
    await assertNoEvtivityWebhook(provider, [webhookUrl]);
    previous = (await db.select().from(settings).where(inArray(settings.key, touchedKeys))).map(
      (row) => ({ key: row.key, value: row.value }),
    );
  }, 60_000);

  afterAll(async () => {
    try {
      if (webhookId != null) await management.deleteWebhook(webhookId);
    } finally {
      // Put the settings back as they were (keys that did not exist become empty).
      const restore = touchedKeys.map(
        (key) => previous.find((p) => p.key === key) ?? { key, value: '' },
      );
      await storeSettings(restore);
      await client.end();
    }
  }, 60_000);

  it('stores the settings, activates the webhook, and Adyen delivers a test event the API accepts', async () => {
    const registration = await provider.registerWebhook({ url: webhookUrl, replace: false });
    webhookId = registration.endpoints[0]?.id ?? null;
    if (webhookId == null) throw new Error('no webhook id');

    // P4: credentials are stored before the webhook is activated.
    await storeSettings([
      { key: 'adyen.apiKeyEnc', value: encryptString(apiKey, encryptionKey) },
      { key: 'adyen.merchantAccount', value: merchantAccount },
      { key: 'adyen.clientKey', value: clientKey },
      { key: 'adyen.environment', value: 'test' },
      ...registration.settings.map((s) => ({
        key: s.key,
        value:
          s.secret && typeof s.value === 'string' && s.value !== ''
            ? encryptString(s.value, encryptionKey)
            : s.value,
      })),
    ]);
    await registration.activate?.();

    // Wait until the API reads the new settings (60 s cache): an event signed
    // with the new key and sent with the new Basic auth is accepted.
    const username = settingValue(registration, 'adyen.webhookUsername');
    const password = settingValue(registration, 'adyen.webhookPasswordEnc');
    const hexKey = settingValue(registration, 'adyen.hmacKeyEnc');
    const probe = (): Promise<Response> =>
      fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: basicAuth(username, password),
        },
        body: signedNotification(
          [
            {
              pspReference: crypto.randomBytes(8).toString('hex').toUpperCase(),
              merchantAccountCode: merchantAccount,
              merchantReference: 'evtivity-live-probe',
              amount: { value: 100, currency: 'EUR' },
              eventCode: 'AUTHORISATION',
              eventDate: new Date().toISOString(),
              success: 'true',
            },
          ],
          { hexKey },
        ),
      });
    const deadline = Date.now() + 120_000;
    let accepted = false;
    while (!accepted && Date.now() < deadline) {
      const res = await probe();
      accepted = res.status === 200 && (await res.text()) === '[accepted]';
      if (!accepted) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    expect(accepted).toBe(true);

    const test = await provider.sendTestWebhook(webhookId);
    expect(test).toMatchObject({ status: 'success', responseCode: '200' });
  }, 240_000);
});
