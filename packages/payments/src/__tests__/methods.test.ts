// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

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
      returning: () => b,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(results[kind].shift() ?? []).then(resolve, reject),
    };
    return b;
  }

  const tx = {
    select: (fields?: unknown) => builder('select', undefined, fields),
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
    stripeCustomerId: 'd.stripe_customer_id',
  },
  driverPaymentMethods: {
    id: 'm.id',
    driverId: 'm.driver_id',
    stripeCustomerId: 'm.stripe_customer_id',
    stripePaymentMethodId: 'm.stripe_payment_method_id',
    createdAt: 'm.created_at',
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
  listDriverMethods,
  removeDriverMethod,
  saveDriverMethod,
  setDefaultDriverMethod,
  startDriverMethodSetup,
} from '../methods.js';
import type { DriverPaymentMethod } from '../methods.js';
import { PaymentMethodOwnershipError, PaymentProviderNotConfiguredError } from '../errors.js';
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
  customerId: 'cus_1' as string | null,
};

function method(overrides: Partial<DriverPaymentMethod> = {}): DriverPaymentMethod {
  return {
    id: 1,
    driverId: 'd1',
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: 'pm_1',
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

  it('returns not_configured when the active provider is not storable', async () => {
    h.results.select.push([DRIVER]);
    getActivePaymentProvider.mockResolvedValue(fakeProvider('adyen'));
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

  it('reuses the driver customer and passes the company currency and country', async () => {
    h.results.select.push([DRIVER]);
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
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.startMethodSetup).toHaveBeenCalledWith({
      customerId: 'cus_1',
      channel: 'native',
      currency: 'EUR',
      countryCode: 'DE',
      nativeSdkVersion: '2026-09-30',
    });
    expect(callsOf('update')).toHaveLength(0);
  });

  it('sends an empty country code when none is set and omits the SDK version', async () => {
    h.results.select.push([DRIVER]);
    h.getCompanyCountry.mockResolvedValue(null);
    await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx);
    expect(stripe.startMethodSetup).toHaveBeenCalledWith({
      customerId: 'cus_1',
      channel: 'web',
      currency: 'EUR',
      countryCode: '',
    });
  });

  it('adopts the legacy customer of the first stored method', async () => {
    h.results.select.push([{ ...DRIVER, customerId: null }], [{ customerId: 'cus_legacy' }]);
    const outcome = await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx);
    expect(outcome).toMatchObject({ status: 'started', customerId: 'cus_legacy' });
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    const [update] = callsOf('update');
    expect(update?.set).toMatchObject({ stripeCustomerId: 'cus_legacy' });
    expect(update?.where).toEqual({ op: 'eq', col: 'd.id', value: 'd1' });
    expect(callsOf('select')[1]?.limit).toBe(1);
  });

  it('creates a customer with a deterministic key when the driver has none', async () => {
    h.results.select.push([{ ...DRIVER, email: null, customerId: null }], []);
    const outcome = await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx);
    expect(stripe.createCustomer).toHaveBeenCalledWith({
      email: '',
      name: 'Ada Lovelace',
      idempotencyKey: 'customer_d1_stripe',
    });
    expect(outcome).toMatchObject({ status: 'started', customerId: 'cus_new' });
    expect(callsOf('update')[0]?.set).toMatchObject({ stripeCustomerId: 'cus_new' });
  });

  it('replaces a stored customer of another provider', async () => {
    h.results.select.push([{ ...DRIVER, customerId: 'cus_sim_1' }]);
    const outcome = await startDriverMethodSetup({ driverId: 'd1', channel: 'web' }, ctx);
    expect(stripe.createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'customer_d1_stripe' }),
    );
    expect(outcome).toMatchObject({ status: 'started', customerId: 'cus_new' });
  });

  it('recovers once from a customer the provider no longer knows', async () => {
    h.results.select.push([DRIVER]);
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
    expect(logger.warn).toHaveBeenCalledWith(
      { err: stale, oldCustomerId: 'cus_1', driverId: 'd1' },
      'Provider rejected the stored customer; creating a new one',
    );
  });

  it('fails when the new customer is rejected too', async () => {
    h.results.select.push([DRIVER]);
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
    h.results.select.push([DRIVER]);
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
    h.results.select.push([{ ...DRIVER, customerId: null }], []);
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

  it('returns not_initialized when the driver has no customer and none is adopted', async () => {
    h.results.select.push([{ ...DRIVER, customerId: null }], []);
    expect(await saveDriverMethod(input, ctx)).toEqual({ status: 'not_initialized' });
  });

  it('returns forbidden when the customer is not the driver own', async () => {
    h.results.select.push([DRIVER]);
    expect(await saveDriverMethod({ ...input, customerId: 'cus_other' }, ctx)).toEqual({
      status: 'forbidden',
    });
    expect(stripe.verifyMethod).not.toHaveBeenCalled();
  });

  it('returns forbidden when the provider reports a method of another customer', async () => {
    h.results.select.push([DRIVER]);
    stripe.verifyMethod.mockRejectedValue(new PaymentMethodOwnershipError());
    expect(await saveDriverMethod(input, ctx)).toEqual({ status: 'forbidden' });
  });

  it('returns not_configured when the pinned provider is not configured', async () => {
    h.results.select.push([DRIVER]);
    getPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('stripe'));
    expect(await saveDriverMethod(input, ctx)).toEqual({ status: 'not_configured' });
  });

  it('returns verify_failed with the reason and logs it', async () => {
    h.results.select.push([DRIVER]);
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

  it('adopts the setup customer and saves the first method as default', async () => {
    h.results.select.push([{ ...DRIVER, customerId: null }], [], []);
    const saved = method({ isDefault: true, stripeCustomerId: 'cus_sim_9' });
    h.results.insert.push([saved]);
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
    expect(callsOf('update')[0]?.set).toMatchObject({ stripeCustomerId: 'cus_sim_9' });
    expect(callsOf('insert')[0]?.values).toEqual({
      driverId: 'd1',
      stripeCustomerId: 'cus_sim_9',
      stripePaymentMethodId: 'pm_sim_9',
      cardBrand: 'mastercard',
      cardLast4: '4444',
      isDefault: true,
    });
  });

  it('refuses to adopt a customer another driver already holds', async () => {
    h.results.select.push([{ ...DRIVER, customerId: null }], []);
    h.execute.mockResolvedValue([{ owned: true }]);
    expect(
      await saveDriverMethod({ ...input, customerId: 'cus_9', adoptCustomer: true }, ctx),
    ).toEqual({ status: 'forbidden' });
    const query = h.execute.mock.calls[0]?.[0] as { values: unknown[] };
    expect(query.values).toEqual(['cus_9', 'd1', 'cus_9', 'd1']);
    expect(stripe.verifyMethod).not.toHaveBeenCalled();
    expect(callsOf('update')).toHaveLength(0);
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('stores a legacy customer on the driver once', async () => {
    h.results.select.push([{ ...DRIVER, customerId: null }], [{ customerId: 'cus_1' }], []);
    h.results.insert.push([method({ isDefault: true })]);
    expect(await saveDriverMethod(input, ctx)).toMatchObject({ status: 'saved' });
    const updates = callsOf('update');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.set).toMatchObject({ stripeCustomerId: 'cus_1' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('saves a later method as not default without touching the driver customer', async () => {
    h.results.select.push([DRIVER], [{ id: 1 }]);
    h.results.insert.push([method({ id: 2 })]);
    const outcome = await saveDriverMethod({ ...input, adoptCustomer: true }, ctx);
    expect(outcome).toMatchObject({ status: 'saved' });
    expect(callsOf('update')).toHaveLength(0);
    expect(callsOf('insert')[0]?.values).toMatchObject({ isDefault: false, cardLast4: '4242' });
  });

  it('throws when the insert returns no row', async () => {
    h.results.select.push([DRIVER], []);
    await expect(saveDriverMethod(input, ctx)).rejects.toThrow('Failed to save payment method');
  });
});

describe('listDriverMethods', () => {
  it('backfills card details once, skips simulated rows and logs failures', async () => {
    const rows = [
      method({ id: 1 }),
      method({ id: 2, cardLast4: null, cardBrand: null, stripeCustomerId: 'cus_sim_2' }),
      method({ id: 3, cardLast4: null, cardBrand: null, stripeCustomerId: 'cus_3' }),
      method({ id: 4, cardLast4: null, cardBrand: null, stripeCustomerId: 'cus_4' }),
      method({ id: 5, cardLast4: null, cardBrand: null, stripeCustomerId: 'cus_5' }),
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
    const updates = callsOf('update');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.set).toMatchObject({ cardBrand: 'amex', cardLast4: '0005' });
    expect(updates[0]?.where).toEqual({ op: 'eq', col: 'm.id', value: 3 });
    expect(rows[2]).toMatchObject({ cardBrand: 'amex', cardLast4: '0005' });
    expect(rows[3]?.cardLast4).toBeNull();
    expect(rows[4]?.cardLast4).toBeNull();
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
    expect(query.values).toEqual(['d1', 'pm_1']);
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
