// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import { AdyenPaymentProvider } from '../providers/adyen/index.js';
import {
  ADYEN_WEBHOOK_EVENT_CODES,
  AdyenManagementClient,
  adyenManagementBaseUrl,
  hasAdyenWebhookRole,
} from '../providers/adyen/management.js';
import { AdyenApiError } from '../providers/adyen/client.js';
import {
  PaymentProviderPermissionError,
  PaymentProviderUnavailableError,
  WebhookExistsError,
} from '../errors.js';
import {
  adyenOptions,
  DOC_HMAC_KEY,
  fakeAdyen,
  fakeAdyenProvider,
  MERCHANT,
  NEW_HMAC_KEY,
  WEBHOOK_ID,
} from '../testing/fake-adyen.js';

const TEST_BASE = 'https://management-test.adyen.com/v3';
const HOOKS = `/v3/merchants/${MERCHANT}/webhooks`;
const URL_ADYEN = 'https://csms.example.com/v1/webhooks/payments/adyen';
const OTHER_DEPLOYMENT_URL = 'https://other.example.com/v1/webhooks/payments/adyen';

function existingWebhook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'WBHK_OLD',
    type: 'standard',
    url: URL_ADYEN,
    description: 'EVtivity payments',
    username: 'evtivity-old',
    hasPassword: true,
    active: true,
    additionalSettings: { includeEventCodes: ['AUTHORISATION'] },
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('Expected a rejection');
}

describe('Adyen Management API client', () => {
  it('uses the test host, or the fixed live host without the live URL prefix', () => {
    expect(adyenManagementBaseUrl('test')).toBe(TEST_BASE);
    expect(adyenManagementBaseUrl('live')).toBe('https://management-live.adyen.com/v3');
  });

  it('reads roles and allowed origins from /me with the API key header', async () => {
    const adyen = fakeAdyen();
    const client = new AdyenManagementClient({
      apiKey: 'AQE_key',
      merchantAccount: MERCHANT,
      environment: 'test',
      fetch: adyen.fetch,
    });
    const info = await client.me();
    expect(info).toEqual({
      roles: ['Checkout webservice role', 'Management API - Webhooks read and write'],
      allowedOrigins: ['http://localhost:7101'],
    });
    expect(adyen.last()).toMatchObject({ method: 'GET', url: `${TEST_BASE}/me` });
    expect(adyen.last().headers['x-api-key']).toBe('AQE_key');
  });

  it('pages through the merchant webhooks', async () => {
    const adyen = fakeAdyen();
    const client = new AdyenManagementClient({
      apiKey: 'k',
      merchantAccount: MERCHANT,
      environment: 'test',
      fetch: adyen.fetch,
    });
    adyen.next(
      { body: { data: [existingWebhook({ id: 'A' })], itemsTotal: 2, pagesTotal: 2 } },
      { body: { data: [existingWebhook({ id: 'B' })], itemsTotal: 2, pagesTotal: 2 } },
    );
    const hooks = await client.listWebhooks();
    expect(hooks.map((h) => h.id)).toEqual(['A', 'B']);
    expect(adyen.calls.map((c) => c.query)).toEqual([
      { pageNumber: '1', pageSize: '100' },
      { pageNumber: '2', pageSize: '100' },
    ]);
  });

  it('maps a 403 to PaymentProviderPermissionError naming the webhook role', async () => {
    const adyen = fakeAdyen();
    const client = new AdyenManagementClient({
      apiKey: 'k',
      merchantAccount: MERCHANT,
      environment: 'test',
      fetch: adyen.fetch,
    });
    adyen.next({ status: 403, body: { status: 403, title: 'Forbidden', errorCode: '00_403' } });
    const err = await rejection(client.listWebhooks());
    expect(err).toBeInstanceOf(PaymentProviderPermissionError);
    expect(err).toMatchObject({
      providerId: 'adyen',
      permission: 'Management API - Webhooks read and write',
    });
  });

  it('reads the problem-details message of a Management API error', async () => {
    const adyen = fakeAdyen();
    const client = new AdyenManagementClient({
      apiKey: 'k',
      merchantAccount: MERCHANT,
      environment: 'test',
      fetch: adyen.fetch,
    });
    adyen.next({
      status: 422,
      body: {
        status: 422,
        title: 'Invalid webhook information provided.',
        invalidFields: [{ name: 'url', message: 'Invalid URL provided' }],
        errorCode: '31_003',
      },
    });
    const err = await rejection(client.createWebhook({ url: 'https://x.invalid' }));
    expect(err).toBeInstanceOf(AdyenApiError);
    expect(err).toMatchObject({ status: 422, errorCode: '31_003' });
    expect((err as Error).message).toBe('Invalid webhook information provided.');
  });

  it('fails when a create answer has no webhook id', async () => {
    const adyen = fakeAdyen();
    const client = new AdyenManagementClient({
      apiKey: 'k',
      merchantAccount: MERCHANT,
      environment: 'test',
      fetch: adyen.fetch,
    });
    adyen.next({ body: {} });
    await expect(client.createWebhook({ url: URL_ADYEN })).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
  });

  it('fails when generateHmac returns no key', async () => {
    const adyen = fakeAdyen();
    const client = new AdyenManagementClient({
      apiKey: 'k',
      merchantAccount: MERCHANT,
      environment: 'test',
      fetch: adyen.fetch,
    });
    adyen.next({ body: {} });
    await expect(client.generateHmac('W')).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
  });

  it('matches the webhook role with a hyphen or a dash', () => {
    expect(hasAdyenWebhookRole(['Management API - Webhooks read and write'])).toBe(true);
    expect(hasAdyenWebhookRole(['Management API—Webhooks read and write'])).toBe(true);
    expect(hasAdyenWebhookRole(['Management API - Webhooks read'])).toBe(false);
    expect(hasAdyenWebhookRole([])).toBe(false);
  });
});

describe('AdyenPaymentProvider webhook registration', () => {
  it('lists only the webhooks EVtivity manages', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({
      body: {
        data: [existingWebhook(), existingWebhook({ id: 'OTHER', description: 'ERP', url: 'x' })],
        pagesTotal: 1,
      },
    });
    expect(await provider.listWebhooks()).toEqual([
      {
        id: 'WBHK_OLD',
        url: URL_ADYEN,
        scope: 'standard',
        enabledEvents: ['AUTHORISATION'],
        apiVersion: null,
        active: true,
      },
    ]);
  });

  it('creates an inactive standard webhook, generates the HMAC key and returns the settings', async () => {
    const { provider, adyen } = fakeAdyenProvider({ hmacKey: null });
    const registration = await provider.registerWebhook({ url: URL_ADYEN, replace: false });

    expect(adyen.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${HOOKS}`,
      `POST ${HOOKS}`,
      `POST ${HOOKS}/${WEBHOOK_ID}/generateHmac`,
    ]);
    const create = adyen.calls[1];
    const body = create?.body ?? {};
    expect(create?.url).toBe(`${TEST_BASE}/merchants/${MERCHANT}/webhooks`);
    expect(create?.headers['x-api-key']).toBe('AQE_test_key');
    expect(body).toMatchObject({
      type: 'standard',
      url: URL_ADYEN,
      active: false,
      communicationFormat: 'json',
      encryptionProtocol: 'TLSv1.3',
      acceptsExpiredCertificate: false,
      acceptsSelfSignedCertificate: false,
      acceptsUntrustedRootCertificate: false,
      description: 'EVtivity payments',
      additionalSettings: { includeEventCodes: [...ADYEN_WEBHOOK_EVENT_CODES] },
    });
    expect(body['username']).toMatch(/^evtivity-[0-9a-f]{12}$/);
    expect(body['password']).toMatch(/^[A-Za-z0-9_-]{32}$/);

    expect(registration.endpoints).toEqual([
      {
        id: WEBHOOK_ID,
        url: URL_ADYEN,
        scope: 'standard',
        enabledEvents: [...ADYEN_WEBHOOK_EVENT_CODES],
        apiVersion: null,
        active: false,
      },
    ]);
    expect(registration.settings).toEqual([
      { key: 'adyen.webhookUsername', value: body['username'], secret: false },
      { key: 'adyen.webhookPasswordEnc', value: body['password'], secret: true },
      { key: 'adyen.hmacKeyEnc', value: NEW_HMAC_KEY, secret: true },
      { key: 'adyen.hmacKeyPreviousEnc', value: '', secret: true },
    ]);

    // Activation is a separate step the caller runs after storing the settings.
    expect(registration.activate).toBeTypeOf('function');
    await registration.activate?.();
    expect(adyen.last()).toMatchObject({
      method: 'PATCH',
      path: `${HOOKS}/${WEBHOOK_ID}`,
      body: { active: true },
    });
  });

  it('uses fresh credentials on every registration', async () => {
    const { provider } = fakeAdyenProvider();
    const a = await provider.registerWebhook({ url: URL_ADYEN, replace: false });
    const b = await provider.registerWebhook({ url: URL_ADYEN, replace: false });
    const value = (r: typeof a, key: string): unknown =>
      r.settings.find((s) => s.key === key)?.value;
    expect(value(a, 'adyen.webhookUsername')).not.toBe(value(b, 'adyen.webhookUsername'));
    expect(value(a, 'adyen.webhookPasswordEnc')).not.toBe(value(b, 'adyen.webhookPasswordEnc'));
  });

  it('refuses when a webhook exists at the URL and replace is false', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({
      body: {
        data: [
          existingWebhook(),
          existingWebhook({ id: 'OTHER_DEPLOYMENT', url: OTHER_DEPLOYMENT_URL }),
          existingWebhook({ id: 'FOREIGN', description: 'ERP', url: 'https://erp.example.com' }),
        ],
      },
    });
    const err = await rejection(provider.registerWebhook({ url: URL_ADYEN, replace: false }));
    expect(err).toBeInstanceOf(WebhookExistsError);
    expect((err as WebhookExistsError).endpoints.map((e) => e.id)).toEqual(['WBHK_OLD']);
    // Another deployment's EVtivity webhook is listed apart; a foreign one not at all.
    expect((err as WebhookExistsError).otherEndpoints.map((e) => e.id)).toEqual([
      'OTHER_DEPLOYMENT',
    ]);
    expect(adyen.calls).toHaveLength(1);
  });

  it("creates a new webhook next to another deployment's EVtivity webhook without touching it", async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({
      body: { data: [existingWebhook({ id: 'OTHER_DEPLOYMENT', url: OTHER_DEPLOYMENT_URL })] },
    });
    const registration = await provider.registerWebhook({ url: URL_ADYEN, replace: true });
    await registration.activate?.();
    expect(adyen.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${HOOKS}`,
      `POST ${HOOKS}`,
      `POST ${HOOKS}/${WEBHOOK_ID}/generateHmac`,
      `PATCH ${HOOKS}/${WEBHOOK_ID}`,
    ]);
    expect(registration.endpoints.map((e) => e.id)).toEqual([WEBHOOK_ID]);
  });

  it('also treats a webhook with the same URL as EVtivity webhook', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({ body: { data: [existingWebhook({ description: 'set up by hand' })] } });
    await expect(
      provider.registerWebhook({ url: URL_ADYEN, replace: false }),
    ).rejects.toBeInstanceOf(WebhookExistsError);
  });

  it('with replace, updates the existing webhook in place and keeps the old HMAC key as previous', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({ body: { data: [existingWebhook()], pagesTotal: 1 } });
    const registration = await provider.registerWebhook({ url: URL_ADYEN, replace: true });

    expect(adyen.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${HOOKS}`,
      `PATCH ${HOOKS}/WBHK_OLD`,
      `POST ${HOOKS}/WBHK_OLD/generateHmac`,
    ]);
    const patch = adyen.calls[1]?.body ?? {};
    // The active flag is left alone: events in the gap fail auth and Adyen retries them.
    expect(patch).not.toHaveProperty('active');
    expect(patch).not.toHaveProperty('type');
    expect(patch).toMatchObject({
      url: URL_ADYEN,
      description: 'EVtivity payments',
      additionalSettings: { includeEventCodes: [...ADYEN_WEBHOOK_EVENT_CODES] },
    });
    expect(patch['password']).toBeTypeOf('string');
    expect(registration.endpoints[0]).toMatchObject({ id: 'WBHK_OLD', active: true });
    expect(registration.settings).toContainEqual({
      key: 'adyen.hmacKeyPreviousEnc',
      value: DOC_HMAC_KEY,
      secret: true,
    });

    await registration.activate?.();
    expect(adyen.calls.slice(3).map((c) => `${c.method} ${c.path}`)).toEqual([
      `PATCH ${HOOKS}/WBHK_OLD`,
    ]);
  });

  it('with replace, prefers the EVtivity webhook at the URL and deletes only duplicates at the URL on activate', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({
      body: {
        data: [
          existingWebhook({ id: 'BY_HAND', description: 'set up by hand' }),
          existingWebhook({ id: 'SAME' }),
          existingWebhook({
            id: 'DUP',
            url: 'https://CSMS.example.com:443/v1/webhooks/payments/adyen',
          }),
          existingWebhook({ id: 'OTHER_DEPLOYMENT', url: OTHER_DEPLOYMENT_URL }),
          existingWebhook({ id: 'FOREIGN', description: 'ERP', url: 'https://erp.example.com' }),
        ],
        pagesTotal: 1,
      },
    });
    const registration = await provider.registerWebhook({ url: URL_ADYEN, replace: true });
    expect(adyen.calls[1]).toMatchObject({ method: 'PATCH', path: `${HOOKS}/SAME` });
    await registration.activate?.();
    expect(adyen.calls.slice(3).map((c) => `${c.method} ${c.path}`)).toEqual([
      `PATCH ${HOOKS}/SAME`,
      `DELETE ${HOOKS}/BY_HAND`,
      `DELETE ${HOOKS}/DUP`,
    ]);
  });

  it('maps a 403 on create to PaymentProviderPermissionError', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({ body: {} }, { status: 403, body: { status: 403, title: 'Forbidden' } });
    await expect(
      provider.registerWebhook({ url: URL_ADYEN, replace: false }),
    ).rejects.toBeInstanceOf(PaymentProviderPermissionError);
  });

  it('never puts the password or HMAC key in an error message', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next(
      { body: {} },
      { status: 422, body: { status: 422, title: 'Bad', errorCode: '31_003' } },
    );
    const err = await rejection(provider.registerWebhook({ url: URL_ADYEN, replace: false }));
    const password = adyen.calls[1]?.body?.['password'] as string;
    expect(err).toBeInstanceOf(AdyenApiError);
    expect(JSON.stringify(err)).not.toContain(password);
    expect((err as Error).message).not.toContain(password);
    expect(String((err as Error).stack)).not.toContain(password);
  });

  it('sends a test AUTHORISATION and returns status, response code and output only', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    const result = await provider.sendTestWebhook(WEBHOOK_ID);
    expect(result).toEqual({ status: 'success', responseCode: '200', output: '[accepted]' });
    expect(adyen.last()).toMatchObject({
      method: 'POST',
      path: `${HOOKS}/${WEBHOOK_ID}/test`,
      body: { types: ['AUTHORISATION'] },
    });
  });

  it('reports a failed test when Adyen returns no result', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({ body: {} });
    expect(await provider.sendTestWebhook(WEBHOOK_ID)).toEqual({
      status: 'failed',
      responseCode: null,
      output: null,
    });
  });

  it('reads credential info through /me', async () => {
    const adyen = fakeAdyen();
    const provider = new AdyenPaymentProvider(adyenOptions(adyen));
    const info = await provider.getCredentialInfo();
    expect(hasAdyenWebhookRole(info.roles)).toBe(true);
  });

  it('uses the live Management host for a live account', async () => {
    const adyen = fakeAdyen();
    const provider = new AdyenPaymentProvider(
      adyenOptions(adyen, { environment: 'live', liveUrlPrefix: '1797a841fbb37ca7-AdyenDemo' }),
    );
    await provider.listWebhooks();
    expect(adyen.last().url).toBe(
      `https://management-live.adyen.com/v3/merchants/${MERCHANT}/webhooks?pageNumber=1&pageSize=100`,
    );
  });
});
