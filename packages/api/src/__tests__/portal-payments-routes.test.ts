// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeChain()),
        insert: vi.fn(() => makeChain()),
        update: vi.fn(() => makeChain()),
        delete: vi.fn(() => makeChain()),
      };
      return fn(tx);
    }),
  },
  drivers: {},
  driverPaymentMethods: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('../services/stripe.service.js', () => ({
  getStripeConfig: vi.fn().mockResolvedValue(null),
  createSetupIntent: vi.fn().mockResolvedValue({ client_secret: 'seti_secret_test' }),
  createCustomer: vi.fn().mockResolvedValue({ id: 'cus_test_123' }),
  detachPaymentMethod: vi.fn().mockResolvedValue({}),
}));

import { registerAuth } from '../plugins/auth.js';
import { portalPaymentRoutes } from '../routes/portal/payments.js';
import {
  getStripeConfig,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  createSetupIntent as _createSetupIntent,
  createCustomer,
  detachPaymentMethod,
} from '../services/stripe.service.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const DRIVER_ID = 'drv_000000000001';
const VALID_PM_ID = '1';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalPaymentRoutes);
  await app.ready();
  return app;
}

describe('Portal payment routes - handler logic', () => {
  let app: FastifyInstance;
  let driverToken: string;

  beforeAll(async () => {
    app = await buildApp();
    driverToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.mocked(getStripeConfig).mockResolvedValue(null);
  });

  describe('GET /v1/portal/payment-methods', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/payment-methods',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 with operator token', async () => {
      const operatorToken = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
      const response = await app.inject({
        method: 'GET',
        url: '/portal/payment-methods',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns empty array when no payment methods', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/payment-methods',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    it('returns payment methods for driver', async () => {
      setupDbResults([
        {
          id: VALID_PM_ID,
          driverId: DRIVER_ID,
          stripeCustomerId: 'cus_test',
          stripePaymentMethodId: 'pm_test',
          cardBrand: 'visa',
          cardLast4: '4242',
          isDefault: true,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/payment-methods',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].cardBrand).toBe('visa');
      expect(body[0].cardLast4).toBe('4242');
    });
  });

  describe('POST /v1/portal/payment-methods/setup-intent', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/setup-intent',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when driver not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/setup-intent',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns 400 when stripe is not configured', async () => {
      setupDbResults([
        { id: DRIVER_ID, email: 'john@example.com', firstName: 'John', lastName: 'Doe' },
      ]);
      vi.mocked(getStripeConfig).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/setup-intent',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('STRIPE_NOT_CONFIGURED');
    });

    it('creates setup intent with existing customer', async () => {
      setupDbResults(
        [{ id: DRIVER_ID, email: 'john@example.com', firstName: 'John', lastName: 'Doe' }],
        [{ stripeCustomerId: 'cus_existing_123' }],
      );
      vi.mocked(getStripeConfig).mockResolvedValue({
        stripe: {} as never,
        publishableKey: 'pk_test_abc',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/setup-intent',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.clientSecret).toBe('seti_secret_test');
      expect(body.customerId).toBe('cus_existing_123');
      expect(body.publishableKey).toBe('pk_test_abc');
    });

    it('creates new customer when no existing payment methods', async () => {
      setupDbResults(
        [{ id: DRIVER_ID, email: 'john@example.com', firstName: 'John', lastName: 'Doe' }],
        [],
      );
      vi.mocked(getStripeConfig).mockResolvedValue({
        stripe: {} as never,
        publishableKey: 'pk_test_abc',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
      });
      vi.mocked(createCustomer).mockResolvedValue({ id: 'cus_new_456' } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/setup-intent',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().customerId).toBe('cus_new_456');
    });
  });

  describe('POST /v1/portal/payment-methods', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods',
        payload: {
          stripePaymentMethodId: 'pm_test',
          stripeCustomerId: 'cus_test',
        },
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 400 with invalid body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('saves payment method as default when first one', async () => {
      const savedMethod = {
        id: VALID_PM_ID,
        driverId: DRIVER_ID,
        stripeCustomerId: 'cus_test',
        stripePaymentMethodId: 'pm_test',
        cardBrand: 'visa',
        cardLast4: '4242',
        isDefault: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([], [savedMethod]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {
          stripePaymentMethodId: 'pm_test',
          stripeCustomerId: 'cus_test',
          cardBrand: 'visa',
          cardLast4: '4242',
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().isDefault).toBe(true);
    });

    it('saves payment method as non-default when others exist', async () => {
      const savedMethod = {
        id: VALID_PM_ID,
        driverId: DRIVER_ID,
        stripeCustomerId: 'cus_test',
        stripePaymentMethodId: 'pm_test_2',
        cardBrand: 'mastercard',
        cardLast4: '5555',
        isDefault: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([{ id: 'existing-pm' }], [savedMethod]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {
          stripePaymentMethodId: 'pm_test_2',
          stripeCustomerId: 'cus_test',
          cardBrand: 'mastercard',
          cardLast4: '5555',
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().isDefault).toBe(false);
    });
  });

  describe('DELETE /v1/portal/payment-methods/:pmId', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/payment-methods/${VALID_PM_ID}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when payment method not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/payment-methods/${VALID_PM_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PAYMENT_METHOD_NOT_FOUND');
    });

    it('deletes payment method and detaches from stripe', async () => {
      setupDbResults(
        [{ id: VALID_PM_ID, stripePaymentMethodId: 'pm_stripe_123', driverId: DRIVER_ID }],
        [],
      );
      vi.mocked(getStripeConfig).mockResolvedValue({
        stripe: {} as never,
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/payment-methods/${VALID_PM_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(detachPaymentMethod).toHaveBeenCalled();
    });

    it('deletes payment method even when stripe not configured', async () => {
      setupDbResults(
        [{ id: VALID_PM_ID, stripePaymentMethodId: 'pm_stripe_123', driverId: DRIVER_ID }],
        [],
      );
      vi.mocked(getStripeConfig).mockResolvedValue(null);

      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/payment-methods/${VALID_PM_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });
  });

  describe('PATCH /v1/portal/payment-methods/:pmId/default', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/payment-methods/${VALID_PM_ID}/default`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when payment method not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/payment-methods/${VALID_PM_ID}/default`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PAYMENT_METHOD_NOT_FOUND');
    });

    it('sets payment method as default', async () => {
      const updatedMethod = {
        id: VALID_PM_ID,
        driverId: DRIVER_ID,
        stripeCustomerId: 'cus_test',
        stripePaymentMethodId: 'pm_test',
        isDefault: true,
        cardBrand: 'visa',
        cardLast4: '4242',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([{ id: VALID_PM_ID }], [], [updatedMethod]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/payment-methods/${VALID_PM_ID}/default`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().isDefault).toBe(true);
    });
  });
});
