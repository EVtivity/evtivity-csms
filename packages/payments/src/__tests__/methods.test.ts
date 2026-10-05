// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

type Kind = 'select' | 'insert' | 'update' | 'delete';

interface Call {
  kind: Kind;
  table?: unknown;
  fields?: unknown;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
  lock?: string;
  conflict?: { kind: 'nothing' | 'update'; config: unknown };
}

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const results: Record<Kind, unknown[][]> = { select: [], insert: [], update: [], delete: [] };

  function builder(kind: Kind, table?: unknown, fields?: unknown): Record<string, unknown> {
    const call: Call = { kind, table, fields };
    calls.push(call);
    const b: Record<string, unknown> = {
      from: (t: unknown) => {
        call.table = t;
        return b;
      },
      values: (v: Record<string, unknown>) => {
        call.values = v;
        return b;
      },
      set: (v: Record<string, unknown>) => {
        call.set = v;
        return b;
      },
      where: (w: unknown) => {
        call.where = w;
        return b;
      },
      orderBy: (...o: unknown[]) => {
        call.orderBy = o;
        return b;
      },
      limit: (n: number) => {
        call.limit = n;
        return b;
      },
      for: (mode: string) => {
        call.lock = mode;
        return b;
      },
      onConflictDoNothing: (config: unknown) => {
        call.conflict = { kind: 'nothing', config };
        return b;
      },
      onConflictDoUpdate: (config: unknown) => {
        call.conflict = { kind: 'update', config };
        return b;
      },
      returning: () => b,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(results[kind].shift() ?? []).then(resolve, reject),
    };
    return b;
  }

  const tx = {
    select: (fields?: unknown) => builder('select', undefined, fields),
    insert: (table: unknown) => builder('insert', table),
    update: (table: unknown) => builder('update', table),
    delete: (table: unknown) => builder('delete', table),
  };
  return {
    calls,
    results,
    tx,
    transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    execute: vi.fn(),
    getCompanyCurrency: vi.fn(),
    getCompanyCountry: vi.fn(),
    db: {
      select: (fields?: unknown) => builder('select', undefined, fields),
      insert: (table: unknown) => builder('insert', table),
      update: (table: unknown) => builder('update', table),
      delete: (table: unknown) => builder('delete', table),
    },
  };
});

vi.mock('@evtivity/database', () => ({
  db: { ...h.db, execute: h.execute, transaction: h.transaction },
  drivers: {
    id: 'd.id',
    email: 'd.email',
    firstName: 'd.first_name',
    lastName: 'd.last_name',
  },
  driverPaymentMethods: {
    id: 'm.id',
    driverId: 'm.driver_id',
    provider: 'm.provider',
    providerCustomerId: 'm.provider_customer_id',
    providerPaymentMethodId: 'm.provider_payment_method_id',
    createdAt: 'm.created_at',
  },
  driverPaymentCustomers: {
    driverId: 'c.driver_id',
    provider: 'c.provider',
    providerCustomerId: 'c.provider_customer_id',
  },
  getCompanyCurrency: h.getCompanyCurrency,
  getCompanyCountry: h.getCompanyCountry,
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, value: unknown) => ({ op: 'eq', col, value }),
  asc: (col: unknown) => ({ op: 'asc', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    text: strings.join('?'),
    values,
  }),
}));

import {
  continueDriverMethodSetup,
  listDriverMethods,
  removeDriverMethod,
  saveDriverMethod,
  setDefaultDriverMethod,
  startDriverMethodSetup,
  submitDriverMethodSetup,
} from '../methods.js';
import type { DriverPaymentMethod } from '../methods.js';
import {
  PaymentDeclinedError,
  PaymentMethodOwnershipError,
  PaymentOperationNotSupportedError,
  PaymentProviderNotConfiguredError,
} from '../errors.js';
import { SimulatedPaymentProvider } from '../providers/simulated/index.js';
import type { PaymentContext } from '../context.js';
import type { PaymentProviderRegistry } from '../registry.js';

interface MethodIds {
  methodId: string;
  customerId: string;
}

interface FakeProvider {
  id: string;
  capabilities: { nativeMobileSheet: boolean };
  createCustomer: Mock<(input: unknown) => Promise<{ customerId: string }>>;
  isUnknownCustomerError: Mock<(err: unknown) => boolean>;
  startMethodSetup: Mock<(input: { customerId: string }) => Promise<unknown>>;
  verifyMethod: Mock<(input: MethodIds) => Promise<unknown>>;
  detachMethod: Mock<(input: unknown) => Promise<void>>;
}

function fakeProvider(id: string, nativeMobileSheet = true): FakeProvider {
  return {
    id,
    capabilities: { nativeMobileSheet },
    createCustomer: vi.fn(() => Promise.resolve({ customerId: 'cus_new' })),
    isUnknownCustomerError: vi.fn(() => false),
    startMethodSetup: vi.fn((input: { customerId: string }) =>
      Promise.resolve({ provider: id, customerId: input.customerId }),
    ),
    verifyMethod: vi.fn((input: MethodIds) =>
      Promise.resolve({ ...input, brand: 'visa', last4: '4242' }),
    ),
    detachMethod: vi.fn(() => Promise.resolve()),
  };
}

let stripe: FakeProvider;
let simulated: FakeProvider;
const getActivePaymentProvider = vi.fn();
const getPaymentProvider = vi.fn();
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: PaymentContext = {
  registry: { getActivePaymentProvider, getPaymentProvider } as unknown as PaymentProviderRegistry,
  logger,
};

const DRIVER = {
  id: 'd1',
  email: 'a@b.c',
  firstName: 'Ada',
  lastName: 'Lovelace',
};

/** The driver's customer row at a provider (driver_payment_customers). */
const CUSTOMER = [{ customerId: 'cus_1' }];
const NO_CUSTOMER: unknown[] = [];

function customerLookup(provider: string): unknown {
  return {
    op: 'and',
    args: [
      { op: 'eq', col: 'c.driver_id', value: 'd1' },
      { op: 'eq', col: 'c.provider', value: provider },
    ],
  };
}

function method(overrides: Partial<DriverPaymentMethod> = {}): DriverPaymentMethod {
  return {
    id: 1,
    driverId: 'd1',
    provider: 'stripe',
    providerCustomerId: 'cus_1',
    providerPaymentMethodId: 'pm_1',
    cardBrand: 'visa',
    cardLast4: '4242',
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function callsOf(kind: Kind): Call[] {
  return h.calls.filter((c) => c.kind === kind);
}

beforeEach(() => {
  h.calls.length = 0;
  for (const queue of Object.values(h.results)) queue.length = 0;
  stripe = fakeProvider('stripe');
  simulated = fakeProvider('simulated');
  getActivePaymentProvider.mockResolvedValue(stripe);
  getPaymentProvider.mockImplementation((id: string) => {
    if (id === 'stripe') return Promise.resolve(stripe);
    if (id === 'simulated') return Promise.resolve(simulated);
    return Promise.reject(new PaymentProviderNotConfiguredError(id));
  });
  h.getCompanyCurrency.mockResolvedValue('EUR');
  h.getCompanyCountry.mockResolvedValue('DE');
  h.execute.mockResolvedValue([{ count: 0 }]);
});

describe('startDriverMethodSetup', () => {
  it('returns driver_not_found for an unknown driver', async () => {
    expect(await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx)).toEqual({
      status: 'driver_not_found',
    });
    expect(getActivePaymentProvider).not.toHaveBeenCalled();
  });

  it('returns not_configured when payments are off', async () => {
    h.results.select.push([DRIVER]);
    getActivePaymentProvider.mockResolvedValue(null);
    expect(await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx)).toEqual({
      status: 'not_configured',
    });
  });

  it('returns not_configured when the selected provider has no credentials', async () => {
    h.results.select.push([DRIVER]);
    getActivePaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('adyen'));
    expect(await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx)).toEqual({
      status: 'not_configured',
    });
  });

  it('propagates other active provider errors', async () => {
    h.results.select.push([DRIVER]);
    getActivePaymentProvider.mockRejectedValue(new Error('settings read failed'));
    await expect(startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx)).rejects.toThrow(
      'settings read failed',
    );
  });

  it('returns not_configured for the native channel without a native sheet', async () => {
    h.results.select.push([DRIVER]);
    getActivePaymentProvider.mockResolvedValue(fakeProvider('stripe', false));
    expect(await startDriverMethodSetup({ driverId: 'd1', channel: 'native' }, ctx)).toEqual({
      status: 'not_configured',
    });
  });

  it('reuses the driver customer at the provider and passes the company currency and country', async () => {
    h.results.select.push([DRIVER], CUSTOMER);
    const outcome = await startDriverMethodSetup(
      { driverId: 'd1', channel: 'native', nativeSdkVersion: '2026-09-30' },
      ctx,
    );
    expect(outcome).toEqual({
      status: 'started',
      providerId: 'stripe',
      customerId: 'cus_1',
      session: { provider: 'stripe', customerId: 'cus_1' },
    });
    expect(callsOf('select')[1]?.where).toEqual(customerLookup('stripe'));
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.startMethodSetup).toHaveBeenCalledWith({
      customerId: 'cus_1',
      channel: 'native',
      currency: 'EUR',
      countryCode: 'DE',
      nativeSdkVersion: '2026-09-30',
    });
    expect(callsOf('insert')).toHaveLength(0);
    expect(callsOf('update')).toHaveLength(0);
  });

  it('sends an empty country code when none is set and omits the SDK version', async () => {
    h.results.select.push([DRIVER], CUSTOMER);
    h.getCompanyCountry.mockResolvedValue(null);
    await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx);
    expect(stripe.startMethodSetup).toHaveBeenCalledWith({
      customerId: 'cus_1',
      channel: 'web',
      currency: 'EUR',
      countryCode: '',
    });
  });

  it('creates a customer with a deterministic key and stores both forms', async () => {
    h.results.select.push([{ ...DRIVER, email: null }], NO_CUSTOMER);
    const outcome = await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx);
    expect(stripe.createCustomer).toHaveBeenCalledWith({
      email: '',
      name: 'Ada Lovelace',
      idempotencyKey: 'customer_d1_stripe',
    });
    expect(outcome).toMatchObject({ status: 'started', customerId: 'cus_new' });
    const [insert] = callsOf('insert');
    expect(insert?.values).toEqual({
      driverId: 'd1',
      provider: 'stripe',
      providerCustomerId: 'cus_new',
    });
    expect(insert?.conflict).toEqual({
      kind: 'update',
      config: {
        target: ['c.driver_id', 'c.provider'],
        set: { providerCustomerId: 'cus_new', updatedAt: expect.any(Date) as unknown },
      },
    });
    expect(callsOf('update')).toHaveLength(0);
  });

  it('creates a customer at the active provider when the driver has one only at another', async () => {
    getActivePaymentProvider.mockResolvedValue(simulated);
    simulated.createCustomer.mockResolvedValue({ customerId: 'cus_sim_new' });
    h.results.select.push([DRIVER], NO_CUSTOMER);
    const outcome = await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx);
    expect(callsOf('select')[1]?.where).toEqual(customerLookup('simulated'));
    expect(simulated.createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'customer_d1_simulated' }),
    );
    expect(outcome).toMatchObject({ status: 'started', customerId: 'cus_sim_new' });
    expect(callsOf('insert')[0]?.values).toMatchObject({ provider: 'simulated' });
  });

  it('recovers once from a customer the provider no longer knows', async () => {
    h.results.select.push([DRIVER], CUSTOMER);
    const stale = new Error('No such customer');
    stripe.startMethodSetup.mockRejectedValueOnce(stale);
    stripe.isUnknownCustomerError.mockImplementation((err: unknown) => err === stale);
    const outcome = await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx);
    expect(stripe.createCustomer).toHaveBeenCalledWith({
      email: 'a@b.c',
      name: 'Ada Lovelace',
      idempotencyKey: 'customer_d1_stripe_cus_1',
    });
    expect(stripe.startMethodSetup).toHaveBeenCalledTimes(2);
    expect(stripe.startMethodSetup).toHaveBeenLastCalledWith(
      expect.objectContaining({ customerId: 'cus_new' }),
    );
    expect(outcome).toMatchObject({ status: 'started', customerId: 'cus_new' });
    expect(callsOf('insert')[0]?.values).toMatchObject({ providerCustomerId: 'cus_new' });
    expect(logger.warn).toHaveBeenCalledWith(
      { err: stale, oldCustomerId: 'cus_1', driverId: 'd1' },
      'Provider rejected the stored customer; creating a new one',
    );
  });

  it('fails when the new customer is rejected too', async () => {
    h.results.select.push([DRIVER], CUSTOMER);
    stripe.startMethodSetup.mockRejectedValue(new Error('No such customer'));
    stripe.isUnknownCustomerError.mockReturnValue(true);
    expect(await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx)).toEqual({
      status: 'failed',
      reason: 'No such customer',
    });
    expect(stripe.startMethodSetup).toHaveBeenCalledTimes(2);
    expect(stripe.createCustomer).toHaveBeenCalledOnce();
  });

  it('returns failed with the logged reason on other errors', async () => {
    h.results.select.push([DRIVER], CUSTOMER);
    const err = new Error('rate limited');
    stripe.startMethodSetup.mockRejectedValue(err);
    expect(await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx)).toEqual({
      status: 'failed',
      reason: 'rate limited',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { err, driverId: 'd1' },
      'Payment method setup failed',
    );
  });

  it('uses the fallback reason for a non-Error failure', async () => {
    h.results.select.push([DRIVER], NO_CUSTOMER);
    stripe.createCustomer.mockRejectedValue('nope');
    expect(await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx)).toEqual({
      status: 'failed',
      reason: 'Payment setup failed',
    });
  });
});

describe('saveDriverMethod', () => {
  const input = { driverId: 'd1', customerId: 'cus_1', methodId: 'pm_1', adoptCustomer: false };

  it('returns driver_not_found for an unknown driver', async () => {
    expect(await saveDriverMethod(input, ctx)).toEqual({ status: 'driver_not_found' });
  });

  it('returns not_configured when payments are off or the provider has no credentials', async () => {
    h.results.select.push([DRIVER]);
    getActivePaymentProvider.mockResolvedValue(null);
    expect(await saveDriverMethod(input, ctx)).toEqual({ status: 'not_configured' });
    h.results.select.push([DRIVER]);
    getActivePaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('adyen'));
    expect(await saveDriverMethod(input, ctx)).toEqual({ status: 'not_configured' });
  });

  it('propagates other active provider errors', async () => {
    h.results.select.push([DRIVER]);
    getActivePaymentProvider.mockRejectedValue(new Error('settings read failed'));
    await expect(saveDriverMethod(input, ctx)).rejects.toThrow('settings read failed');
  });

  it('returns not_initialized when the driver has no customer and none is adopted', async () => {
    h.results.select.push([DRIVER], NO_CUSTOMER);
    expect(await saveDriverMethod(input, ctx)).toEqual({ status: 'not_initialized' });
  });

  it('returns forbidden when the customer is not the driver own', async () => {
    h.results.select.push([DRIVER], CUSTOMER);
    expect(await saveDriverMethod({ ...input, customerId: 'cus_other' }, ctx)).toEqual({
      status: 'forbidden',
    });
    expect(stripe.verifyMethod).not.toHaveBeenCalled();
  });

  it('returns forbidden when the provider reports a method of another customer', async () => {
    h.results.select.push([DRIVER], CUSTOMER);
    stripe.verifyMethod.mockRejectedValue(new PaymentMethodOwnershipError());
    expect(await saveDriverMethod(input, ctx)).toEqual({ status: 'forbidden' });
  });

  it('returns not_configured when the provider reports it is not configured', async () => {
    h.results.select.push([DRIVER], CUSTOMER);
    stripe.verifyMethod.mockRejectedValue(new PaymentProviderNotConfiguredError('stripe'));
    expect(await saveDriverMethod(input, ctx)).toEqual({ status: 'not_configured' });
  });

  it('returns verify_failed with the reason and logs it', async () => {
    h.results.select.push([DRIVER], CUSTOMER);
    const err = new Error('network');
    stripe.verifyMethod.mockRejectedValue(err);
    expect(await saveDriverMethod(input, ctx)).toEqual({
      status: 'verify_failed',
      reason: 'network',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { err, paymentMethodId: 'pm_1' },
      'Failed to verify the payment method; refusing to save it',
    );
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('adopts the setup customer and saves the first method as default in both forms', async () => {
    getActivePaymentProvider.mockResolvedValue(simulated);
    h.results.select.push([DRIVER], NO_CUSTOMER, []);
    const saved = method({ isDefault: true, provider: 'simulated' });
    h.results.insert.push([], [saved]);
    simulated.verifyMethod.mockResolvedValue({
      methodId: 'pm_sim_9',
      customerId: 'cus_sim_9',
      brand: 'mastercard',
      last4: '4444',
    });
    const outcome = await saveDriverMethod(
      { driverId: 'd1', customerId: 'cus_sim_9', methodId: 'pm_sim_9', adoptCustomer: true },
      ctx,
    );
    expect(outcome).toEqual({ status: 'saved', method: saved });
    expect(simulated.verifyMethod).toHaveBeenCalledWith({
      methodId: 'pm_sim_9',
      customerId: 'cus_sim_9',
    });
    const query = h.execute.mock.calls[0]?.[0] as { values: unknown[] };
    expect(query.values).toEqual(['simulated', 'cus_sim_9', 'd1', 'simulated', 'cus_sim_9', 'd1']);
    const [customer, inserted] = callsOf('insert');
    expect(customer?.values).toEqual({
      driverId: 'd1',
      provider: 'simulated',
      providerCustomerId: 'cus_sim_9',
    });
    expect(callsOf('update')).toHaveLength(0);
    expect(inserted?.values).toEqual({
      driverId: 'd1',
      provider: 'simulated',
      providerCustomerId: 'cus_sim_9',
      providerPaymentMethodId: 'pm_sim_9',
      cardBrand: 'mastercard',
      cardLast4: '4444',
      isDefault: true,
    });
    expect(inserted?.conflict).toEqual({
      kind: 'nothing',
      config: { target: ['m.driver_id', 'm.provider', 'm.provider_payment_method_id'] },
    });
  });

  it('refuses to adopt a customer another driver already holds', async () => {
    h.results.select.push([DRIVER], NO_CUSTOMER);
    h.execute.mockResolvedValue([{ owned: true }]);
    expect(
      await saveDriverMethod({ ...input, customerId: 'cus_9', adoptCustomer: true }, ctx),
    ).toEqual({ status: 'forbidden' });
    const query = h.execute.mock.calls[0]?.[0] as { values: unknown[] };
    expect(query.values).toEqual(['stripe', 'cus_9', 'd1', 'stripe', 'cus_9', 'd1']);
    expect(stripe.verifyMethod).not.toHaveBeenCalled();
    expect(callsOf('update')).toHaveLength(0);
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('saves a later method as not default without touching the driver customer', async () => {
    h.results.select.push([DRIVER], CUSTOMER, [{ id: 1 }]);
    h.results.insert.push([method({ id: 2 })]);
    const outcome = await saveDriverMethod({ ...input, adoptCustomer: true }, ctx);
    expect(outcome).toMatchObject({ status: 'saved' });
    expect(callsOf('update')).toHaveLength(0);
    expect(callsOf('insert')).toHaveLength(1);
    expect(callsOf('insert')[0]?.values).toMatchObject({
      provider: 'stripe',
      providerCustomerId: 'cus_1',
      providerPaymentMethodId: 'pm_1',
      isDefault: false,
      cardLast4: '4242',
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('saves an Adyen card with its provider ids', async () => {
    const adyen = fakeProvider('adyen');
    getActivePaymentProvider.mockResolvedValue(adyen);
    h.results.select.push([DRIVER], [{ customerId: 'evt_shopper' }], []);
    h.results.insert.push([method({ id: 3, provider: 'adyen' })]);
    const outcome = await saveDriverMethod(
      { ...input, customerId: 'evt_shopper', methodId: 'M5N7TQ4TG5PFWR50' },
      ctx,
    );
    expect(outcome).toMatchObject({ status: 'saved' });
    expect(callsOf('insert')[0]?.values).toMatchObject({
      provider: 'adyen',
      providerCustomerId: 'evt_shopper',
      providerPaymentMethodId: 'M5N7TQ4TG5PFWR50',
    });
  });

  it('returns the stored row when the method was saved before (P7)', async () => {
    const stored = method({ id: 7, isDefault: true });
    h.results.select.push([DRIVER], CUSTOMER, [{ id: 7 }], [stored]);
    h.results.insert.push([]);
    expect(await saveDriverMethod(input, ctx)).toEqual({ status: 'saved', method: stored });
    expect(stripe.verifyMethod).toHaveBeenCalledOnce();
    expect(callsOf('select')[3]?.where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'm.driver_id', value: 'd1' },
        { op: 'eq', col: 'm.provider', value: 'stripe' },
        { op: 'eq', col: 'm.provider_payment_method_id', value: 'pm_1' },
      ],
    });
  });

  it('throws when neither the insert nor the lookup returns a row', async () => {
    h.results.select.push([DRIVER], CUSTOMER, []);
    await expect(saveDriverMethod(input, ctx)).rejects.toThrow('Failed to save payment method');
  });
});

describe('submitDriverMethodSetup and continueDriverMethodSetup', () => {
  const SIM_CUSTOMER = [{ customerId: 'cus_sim_1' }];
  let sim: SimulatedPaymentProvider;

  beforeEach(() => {
    sim = new SimulatedPaymentProvider({ encryptionKey: 'test-encryption-key-32chars-long!' });
    getActivePaymentProvider.mockResolvedValue(sim);
  });

  function submit(testCard: string, overrides: Partial<{ adoptCustomer: boolean }> = {}) {
    return submitDriverMethodSetup(
      {
        driverId: 'd1',
        providerId: 'simulated',
        attemptId: 'att-1',
        payload: { testCard },
        adoptCustomer: false,
        ...overrides,
      },
      ctx,
    );
  }

  function saved(values: Record<string, unknown> | undefined): DriverPaymentMethod {
    return method({ ...(values as Partial<DriverPaymentMethod>), id: 3 });
  }

  it('saves an approved test card as the first, default method in both forms', async () => {
    const row = method({ id: 3 });
    h.results.select.push([DRIVER], SIM_CUSTOMER, []);
    h.results.insert.push([row]);
    const outcome = await submit('4242424242424242');
    expect(outcome).toEqual({ status: 'saved', method: row });
    const [insert] = callsOf('insert');
    expect(insert?.values).toMatchObject({
      driverId: 'd1',
      provider: 'simulated',
      providerCustomerId: 'cus_sim_1',
      cardBrand: 'visa',
      cardLast4: '4242',
      isDefault: true,
    });
    expect(String(insert?.values?.['providerPaymentMethodId'])).toMatch(/^pm_sim_approve_4242_/);
    expect(insert?.conflict?.kind).toBe('nothing');
  });

  it('saves the same method for the same attemptId, so a replay returns the stored row (P7)', async () => {
    h.results.select.push([DRIVER], SIM_CUSTOMER, []);
    h.results.insert.push([method({ id: 3 })]);
    await submit('4242424242424242');
    const first = callsOf('insert')[0]?.values;

    const stored = saved(first);
    h.results.select.push([DRIVER], SIM_CUSTOMER, [{ id: 3 }], [stored]);
    h.results.insert.push([]);
    expect(await submit('4242424242424242')).toEqual({ status: 'saved', method: stored });
    const second = callsOf('insert')[1]?.values;
    expect(second?.['providerPaymentMethodId']).toBe(first?.['providerPaymentMethodId']);
    expect(second?.['isDefault']).toBe(false);
  });

  it('passes the browser to the provider for a 3DS step, and omits it when absent', async () => {
    const spy = vi.spyOn(sim, 'submitMethodSetup');
    const browser = { origin: 'https://portal.example', returnUrl: 'https://portal.example/r' };
    h.results.select.push([DRIVER], SIM_CUSTOMER, []);
    h.results.insert.push([method({ id: 3 })]);
    await submitDriverMethodSetup(
      {
        driverId: 'd1',
        providerId: 'simulated',
        attemptId: 'att-1',
        payload: { testCard: '4242424242424242' },
        browser,
        adoptCustomer: false,
      },
      ctx,
    );
    expect(spy).toHaveBeenLastCalledWith({
      customerId: 'cus_sim_1',
      payload: { testCard: '4242424242424242' },
      browser,
      idempotencyKey: `method_setup_${createHash('sha256').update('d1:att-1').digest('hex').slice(0, 32)}`,
    });

    h.results.select.push([DRIVER], SIM_CUSTOMER, []);
    h.results.insert.push([method({ id: 3 })]);
    await submit('4242424242424242');
    expect(spy.mock.calls.at(-1)?.[0]).not.toHaveProperty('browser');
  });

  it('returns refused for a declined card and stores nothing', async () => {
    h.results.select.push([DRIVER], SIM_CUSTOMER);
    expect(await submit('4000000000000002')).toEqual({
      status: 'refused',
      reason: 'card_declined',
    });
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('returns the challenge for an authentication card, then saves on approve', async () => {
    h.results.select.push([DRIVER], SIM_CUSTOMER);
    const outcome = await submit('4000002500003155');
    expect(outcome).toMatchObject({
      status: 'action_required',
      action: { provider: 'simulated', data: { challenge: 'method_setup' } },
    });
    expect(callsOf('insert')).toHaveLength(0);
    const { methodId } = (outcome as { action: { data: { methodId: string } } }).action.data;

    h.results.select.push([DRIVER], SIM_CUSTOMER, []);
    const row4 = method({ id: 4 });
    h.results.insert.push([row4]);
    const approved = await continueDriverMethodSetup(
      {
        driverId: 'd1',
        providerId: 'simulated',
        attemptId: 'att-1',
        details: { methodId, outcome: 'approve' },
      },
      ctx,
    );
    expect(approved).toEqual({ status: 'saved', method: row4 });
    expect(callsOf('insert')[0]?.values).toMatchObject({
      providerPaymentMethodId: methodId,
      cardLast4: '3155',
    });
  });

  it('returns refused when the challenge fails', async () => {
    h.results.select.push([DRIVER], SIM_CUSTOMER);
    const outcome = await submit('4000002500003155');
    const { methodId } = (outcome as { action: { data: { methodId: string } } }).action.data;
    h.results.select.push([DRIVER], SIM_CUSTOMER);
    expect(
      await continueDriverMethodSetup(
        {
          driverId: 'd1',
          providerId: 'simulated',
          attemptId: 'att-1',
          details: { methodId, outcome: 'fail' },
        },
        ctx,
      ),
    ).toEqual({ status: 'refused', reason: 'authentication_failed' });
  });

  it('returns invalid for an unknown test card or details without a challenge', async () => {
    h.results.select.push([DRIVER], SIM_CUSTOMER);
    expect(await submit('4000000000009999')).toEqual({
      status: 'invalid',
      reason: 'Unknown test card',
    });
    h.results.select.push([DRIVER], SIM_CUSTOMER);
    expect(
      await continueDriverMethodSetup(
        { driverId: 'd1', providerId: 'simulated', attemptId: 'att-1', details: {} },
        ctx,
      ),
    ).toEqual({ status: 'invalid', reason: 'No simulated challenge for this method' });
  });

  it('returns provider_mismatch when another provider is active', async () => {
    getActivePaymentProvider.mockResolvedValue(stripe);
    h.results.select.push([DRIVER]);
    expect(await submit('4242424242424242')).toEqual({ status: 'provider_mismatch' });
  });

  it('returns driver_not_found, not_configured and not_initialized', async () => {
    expect(await submit('4242424242424242')).toEqual({ status: 'driver_not_found' });

    h.results.select.push([DRIVER]);
    getActivePaymentProvider.mockResolvedValueOnce(null);
    expect(await submit('4242424242424242')).toEqual({ status: 'not_configured' });

    h.results.select.push([DRIVER]);
    getActivePaymentProvider.mockRejectedValueOnce(
      new PaymentProviderNotConfiguredError('simulated'),
    );
    expect(await submit('4242424242424242')).toEqual({ status: 'not_configured' });

    h.results.select.push([DRIVER], NO_CUSTOMER);
    expect(await submit('4242424242424242')).toEqual({ status: 'not_initialized' });
  });

  it('creates the customer for an operator adding a card to a driver without one', async () => {
    const createCustomer = vi.spyOn(sim, 'createCustomer');
    h.results.select.push([DRIVER], NO_CUSTOMER, NO_CUSTOMER, []);
    const row5 = method({ id: 5 });
    h.results.insert.push([], [row5]);
    const outcome = await submit('4242424242424242', { adoptCustomer: true });
    expect(outcome).toEqual({ status: 'saved', method: row5 });
    expect(createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'customer_d1_simulated' }),
    );
    const [customerInsert, methodInsert] = callsOf('insert');
    expect(customerInsert?.values).toMatchObject({ driverId: 'd1', provider: 'simulated' });
    expect(methodInsert?.values?.['providerCustomerId']).toBe(
      customerInsert?.values?.['providerCustomerId'],
    );
  });

  it('maps an ownership error to forbidden and rethrows other provider errors', async () => {
    h.results.select.push([DRIVER], [{ customerId: 'cus_other' }]);
    expect(await submit('4242424242424242')).toEqual({ status: 'forbidden' });

    h.results.select.push([DRIVER], SIM_CUSTOMER);
    vi.spyOn(sim, 'submitMethodSetup').mockRejectedValueOnce(new Error('provider down'));
    await expect(submit('4242424242424242')).rejects.toThrow('provider down');
  });

  it('maps a decline to refused and an unsupported step to invalid', async () => {
    h.results.select.push([DRIVER], SIM_CUSTOMER);
    vi.spyOn(sim, 'submitMethodSetup').mockRejectedValueOnce(
      new PaymentDeclinedError('Declined', { code: 'do_not_honor' }),
    );
    expect(await submit('4242424242424242')).toEqual({ status: 'refused', reason: 'do_not_honor' });

    h.results.select.push([DRIVER], SIM_CUSTOMER);
    vi.spyOn(sim, 'continueMethodSetup').mockRejectedValueOnce(
      new PaymentOperationNotSupportedError('simulated', 'continueMethodSetup'),
    );
    const outcome = await continueDriverMethodSetup(
      { driverId: 'd1', providerId: 'simulated', attemptId: 'att-1', details: {} },
      ctx,
    );
    expect(outcome.status).toBe('invalid');
  });

  it('refuses a saved method the provider reports for another customer', async () => {
    h.results.select.push([DRIVER], SIM_CUSTOMER);
    vi.spyOn(sim, 'submitMethodSetup').mockResolvedValueOnce({
      status: 'saved',
      method: { methodId: 'pm_sim_x', customerId: 'cus_sim_2', brand: null, last4: null },
    });
    expect(await submit('4242424242424242')).toEqual({ status: 'forbidden' });
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('uses deterministic idempotency keys per attempt and per details, within 64 characters', async () => {
    const submitSpy = vi.spyOn(sim, 'submitMethodSetup');
    const continueSpy = vi.spyOn(sim, 'continueMethodSetup');
    const digest = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 32);
    h.results.select.push([DRIVER], SIM_CUSTOMER, [DRIVER], SIM_CUSTOMER);
    h.results.select.push([DRIVER], SIM_CUSTOMER);
    await submit('4000000000000002');
    const continueWith = (details: unknown) =>
      continueDriverMethodSetup(
        { driverId: 'd1', providerId: 'simulated', attemptId: 'att-1', details },
        ctx,
      );
    await continueWith({});
    await continueWith({ step: 2 });
    expect(submitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `method_setup_${digest('d1:att-1')}` }),
    );
    const keys = continueSpy.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toEqual([
      `method_setup_details_${digest('d1:att-1:{}')}`,
      `method_setup_details_${digest('d1:att-1:{"step":2}')}`,
    ]);
    // A real driver id and attempt UUID stay within Adyen's 64-character limit.
    expect(`method_setup_details_${digest('x')}`.length).toBeLessThanOrEqual(64);
  });
});

describe('listDriverMethods', () => {
  it('backfills card details once, skips simulated rows and logs failures', async () => {
    const rows = [
      method({ id: 1 }),
      method({
        id: 2,
        cardLast4: null,
        cardBrand: null,
        provider: 'simulated',
        providerCustomerId: 'cus_sim_2',
      }),
      method({ id: 3, cardLast4: null, cardBrand: null, providerCustomerId: 'cus_3' }),
      method({ id: 4, cardLast4: null, cardBrand: null, providerCustomerId: 'cus_4' }),
      method({ id: 5, cardLast4: null, cardBrand: null, providerCustomerId: 'cus_5' }),
      method({ id: 6, cardLast4: null, cardBrand: null, provider: 'adyen' }),
    ];
    h.results.select.push(rows);
    const err = new Error('gone');
    stripe.verifyMethod.mockImplementation((i: MethodIds) => {
      if (i.customerId === 'cus_4') return Promise.reject(err);
      if (i.customerId === 'cus_5') return Promise.resolve({ ...i, brand: null, last4: null });
      return Promise.resolve({ ...i, brand: 'amex', last4: '0005' });
    });

    const result = await listDriverMethods('d1', ctx);

    expect(result).toBe(rows);
    expect(stripe.verifyMethod).toHaveBeenCalledTimes(3);
    expect(simulated.verifyMethod).not.toHaveBeenCalled();
    expect(getPaymentProvider).not.toHaveBeenCalledWith('simulated');
    const updates = callsOf('update');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.set).toMatchObject({ cardBrand: 'amex', cardLast4: '0005' });
    expect(updates[0]?.where).toEqual({ op: 'eq', col: 'm.id', value: 3 });
    expect(rows[2]).toMatchObject({ cardBrand: 'amex', cardLast4: '0005' });
    expect(rows[3]?.cardLast4).toBeNull();
    expect(rows[4]?.cardLast4).toBeNull();
    expect(rows[5]?.cardLast4).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      { err, paymentMethodId: 'pm_1' },
      'Failed to backfill card details from the payment provider',
    );
    expect(callsOf('select')[0]?.orderBy).toEqual([
      { op: 'desc', col: 'm.created_at' },
      { op: 'desc', col: 'm.id' },
    ]);
  });
});

describe('removeDriverMethod', () => {
  const input = { driverId: 'd1', methodRowId: 1, blockWhenInUse: false };

  it('returns not_found for a method that is not the driver own', async () => {
    expect(await removeDriverMethod(input, ctx)).toEqual({ status: 'not_found' });
    expect(callsOf('select')[0]?.where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'm.id', value: 1 },
        { op: 'eq', col: 'm.driver_id', value: 'd1' },
      ],
    });
  });

  it('returns in_use for a method holding an open payment when blocking', async () => {
    h.results.select.push([method()]);
    h.execute.mockResolvedValue([{ count: 1 }]);
    expect(await removeDriverMethod({ ...input, blockWhenInUse: true }, ctx)).toEqual({
      status: 'in_use',
    });
    const query = h.execute.mock.calls[0]?.[0] as { values: unknown[] };
    expect(query.values).toEqual(['d1', 'stripe', 'pm_1']);
    expect(stripe.detachMethod).not.toHaveBeenCalled();
    expect(callsOf('delete')).toHaveLength(0);
  });

  it('removes an unused method when blocking, and does not check without blocking', async () => {
    h.results.select.push([method()]);
    h.execute.mockResolvedValue([]);
    expect(await removeDriverMethod({ ...input, blockWhenInUse: true }, ctx)).toEqual({
      status: 'removed',
    });
    expect(h.execute).toHaveBeenCalledOnce();

    h.results.select.push([method()]);
    expect(await removeDriverMethod(input, ctx)).toEqual({ status: 'removed' });
    expect(h.execute).toHaveBeenCalledOnce();
    expect(stripe.detachMethod).toHaveBeenCalledWith({ customerId: 'cus_1', methodId: 'pm_1' });
    expect(callsOf('delete')).toHaveLength(2);
    expect(callsOf('update')).toHaveLength(0);
    expect(callsOf('select')).toHaveLength(2);
    expect(h.transaction).toHaveBeenCalledTimes(2);
  });

  it('detaches with the provider the method was saved with', async () => {
    getActivePaymentProvider.mockResolvedValue(stripe);
    h.results.select.push([
      method({
        provider: 'simulated',
        providerCustomerId: 'cus_sim_1',
        providerPaymentMethodId: 'pm_sim_1',
      }),
    ]);
    expect(await removeDriverMethod(input, ctx)).toEqual({ status: 'removed' });
    expect(simulated.detachMethod).toHaveBeenCalledWith({
      customerId: 'cus_sim_1',
      methodId: 'pm_sim_1',
    });
    expect(stripe.detachMethod).not.toHaveBeenCalled();
  });

  it('logs a detach failure and still deletes the row', async () => {
    h.results.select.push([method()]);
    const err = new Error('already detached');
    stripe.detachMethod.mockRejectedValue(err);
    expect(await removeDriverMethod(input, ctx)).toEqual({ status: 'removed' });
    expect(logger.warn).toHaveBeenCalledWith(
      { err, paymentMethodId: 'pm_1' },
      'Failed to detach the payment method at the provider; deleting the local row anyway',
    );
    expect(callsOf('delete')[0]?.where).toEqual({ op: 'eq', col: 'm.id', value: 1 });
  });

  it('promotes the oldest remaining method when the default is removed', async () => {
    h.results.select.push([method({ isDefault: true })], [{ id: 9 }]);
    expect(await removeDriverMethod(input, ctx)).toEqual({ status: 'removed' });
    const next = callsOf('select')[1];
    expect(next?.orderBy).toEqual([{ op: 'asc', col: 'm.created_at' }]);
    expect(next?.limit).toBe(1);
    expect(next?.lock).toBe('update');
    expect(h.transaction).toHaveBeenCalledOnce();
    const [update] = callsOf('update');
    expect(update?.set).toMatchObject({ isDefault: true });
    expect(update?.where).toEqual({ op: 'eq', col: 'm.id', value: 9 });
  });

  it('promotes nothing when the default was the last method', async () => {
    h.results.select.push([method({ isDefault: true })], []);
    expect(await removeDriverMethod(input, ctx)).toEqual({ status: 'removed' });
    expect(callsOf('update')).toHaveLength(0);
  });
});

describe('setDefaultDriverMethod', () => {
  it('returns null for a method that is not the driver own', async () => {
    expect(await setDefaultDriverMethod('d1', 3)).toBeNull();
    expect(callsOf('update')).toHaveLength(0);
  });

  it('flips the default in one update over all the driver methods', async () => {
    const row = method({ id: 3, isDefault: true });
    h.results.select.push([{ id: 3 }], [row]);
    expect(await setDefaultDriverMethod('d1', 3)).toBe(row);
    const [update] = callsOf('update');
    expect(update?.where).toEqual({ op: 'eq', col: 'm.driver_id', value: 'd1' });
    expect(update?.set?.['isDefault']).toEqual({ op: 'sql', text: '(? = ?)', values: ['m.id', 3] });
  });

  it('returns null when the row is gone after the update', async () => {
    h.results.select.push([{ id: 3 }], []);
    expect(await setDefaultDriverMethod('d1', 3)).toBeNull();
  });
});
