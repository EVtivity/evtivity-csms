// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Golden Stripe-call recorder (plan 2026-10-03, B4). A fake `stripe` module
 * that records every request the code under test sends (resource, method,
 * arguments, request options such as the idempotency key) and answers like
 * Stripe test mode does. The golden integration tests (API, worker, OCPP)
 * mock `stripe` with it, run each payment flow, and compare the recorded calls
 * plus the resulting payment state with committed JSON files. The refactors
 * that move callers to @evtivity/payments must reproduce them, except for
 * documented, planned differences.
 *
 * Use in a test file:
 *
 *   vi.mock('stripe', async () =>
 *     (await import('@evtivity/payments/testing')).fakeStripeModule());
 *
 * The test imports `stripeRecorder` from the same module (one instance).
 */

export interface RecordedStripeCall {
  call: string;
  args: unknown[];
  options?: unknown;
}

export interface FakeIntent {
  id: string;
  object: 'payment_intent';
  amount: number;
  currency: string;
  customer: string | null;
  payment_method: string | null;
  capture_method: string;
  status: string;
  amount_capturable: number;
  amount_received: number;
  on_behalf_of: string | null;
  transfer_data: { destination: string } | null;
  application_fee_amount: number | null;
  client_secret: string;
  last_payment_error: null;
}

interface FakePaymentMethod {
  id: string;
  customer: string | null;
  card: { brand: string; last4: string };
}

/** A Stripe SDK error shape: `type` drives error handling in the code under test. */
export class FakeStripeError extends Error {
  readonly type: string;
  readonly code: string | undefined;
  readonly decline_code: string | undefined;
  readonly statusCode: number;

  constructor(
    type: string,
    message: string,
    options: { code?: string; declineCode?: string; statusCode?: number } = {},
  ) {
    super(message);
    this.type = type;
    this.code = options.code;
    this.decline_code = options.declineCode;
    this.statusCode = options.statusCode ?? 402;
  }
}

function cardDeclined(declineCode = 'generic_decline'): FakeStripeError {
  return new FakeStripeError('StripeCardError', 'Your card was declined.', {
    code: 'card_declined',
    declineCode,
  });
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

class StripeRecorder {
  calls: RecordedStripeCall[] = [];
  intents = new Map<string, FakeIntent>();
  paymentMethods = new Map<string, FakePaymentMethod>();
  /** Methods whose every PaymentIntent is declined (Stripe 4000 0000 0000 0002). */
  declineMethods = new Set<string>();
  /** Methods that hold fine but decline immediate charges (Stripe 4000 0000 0000 0341). */
  chargeFailMethods = new Set<string>();
  /** Methods that need 3DS (Stripe 4000 0025 0000 3155). */
  actionMethods = new Set<string>();
  /** Intents whose capture fails. */
  captureFailIntents = new Set<string>();
  /** Intents whose retrieve fails (network). */
  retrieveFailIntents = new Set<string>();
  /** Customers Stripe does not know (deleted, or another account). */
  staleCustomers = new Set<string>();
  private counters = new Map<string, number>();

  reset(): void {
    this.calls = [];
    this.intents.clear();
    this.paymentMethods.clear();
    this.declineMethods.clear();
    this.chargeFailMethods.clear();
    this.actionMethods.clear();
    this.captureFailIntents.clear();
    this.retrieveFailIntents.clear();
    this.staleCustomers.clear();
    this.counters.clear();
  }

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${String(n)}`;
  }

  record(call: string, args: unknown[], options?: unknown): void {
    const entry: RecordedStripeCall = { call, args: args.map((a) => clone(a)) };
    if (options !== undefined) entry.options = clone(options);
    this.calls.push(entry);
  }

  /** An intent that exists in Stripe before the scenario (records seeded in the DB). */
  seedIntent(id: string, fields: Partial<FakeIntent> = {}): FakeIntent {
    const intent: FakeIntent = {
      id,
      object: 'payment_intent',
      amount: 5000,
      currency: 'usd',
      customer: 'cus_seeded',
      payment_method: 'pm_seeded',
      capture_method: 'manual',
      status: 'requires_capture',
      amount_capturable: 5000,
      amount_received: 0,
      on_behalf_of: null,
      transfer_data: null,
      application_fee_amount: null,
      client_secret: `${id}_secret`,
      last_payment_error: null,
      ...fields,
    };
    this.intents.set(id, intent);
    return intent;
  }

  seedPaymentMethod(id: string, customer: string | null, last4 = '4242', brand = 'visa'): void {
    this.paymentMethods.set(id, { id, customer, card: { brand, last4 } });
  }
}

export const stripeRecorder = new StripeRecorder();

interface RequestOptions {
  idempotencyKey?: string;
  apiVersion?: string;
}

function createIntent(params: Record<string, unknown>, options?: RequestOptions): FakeIntent {
  const r = stripeRecorder;
  const method = (params['payment_method'] as string | undefined) ?? null;
  const manual = params['capture_method'] === 'manual';
  const offSession = params['off_session'] === true;
  if (method != null && r.declineMethods.has(method)) throw cardDeclined();
  if (method != null && !manual && r.chargeFailMethods.has(method)) throw cardDeclined();
  if (method != null && r.actionMethods.has(method) && offSession) {
    throw new FakeStripeError(
      'StripeCardError',
      'Your card was declined. This transaction requires authentication.',
      { code: 'authentication_required', declineCode: 'authentication_required' },
    );
  }
  const id = options?.idempotencyKey != null ? `pi_${options.idempotencyKey}` : r.next('pi_auto');
  const existing = r.intents.get(id);
  // Stripe replays the first response for a repeated idempotency key.
  if (existing != null) return existing;
  const amount = params['amount'] as number;
  const status =
    method != null && r.actionMethods.has(method)
      ? 'requires_action'
      : manual
        ? 'requires_capture'
        : 'succeeded';
  const transfer = params['transfer_data'] as { destination: string } | undefined;
  const intent: FakeIntent = {
    id,
    object: 'payment_intent',
    amount,
    currency: params['currency'] as string,
    customer: (params['customer'] as string | undefined) ?? null,
    payment_method: method,
    capture_method: manual ? 'manual' : 'automatic',
    status,
    amount_capturable: status === 'requires_capture' ? amount : 0,
    amount_received: status === 'succeeded' ? amount : 0,
    on_behalf_of: (params['on_behalf_of'] as string | undefined) ?? null,
    transfer_data: transfer ?? null,
    application_fee_amount: (params['application_fee_amount'] as number | undefined) ?? null,
    client_secret: `${id}_secret`,
    last_payment_error: null,
  };
  r.intents.set(id, intent);
  return intent;
}

function getIntent(id: string): FakeIntent {
  const intent = stripeRecorder.intents.get(id);
  if (intent == null) {
    throw new FakeStripeError('StripeInvalidRequestError', `No such payment_intent: '${id}'`, {
      code: 'resource_missing',
      statusCode: 404,
    });
  }
  return intent;
}

/** Stand-in for `new Stripe(key, config)`; every instance shares the recorder. */
class FakeStripe {
  paymentIntents = {
    create: (params: Record<string, unknown>, options?: RequestOptions): Promise<FakeIntent> => {
      stripeRecorder.record('paymentIntents.create', [params], options);
      return settle(() => createIntent(params, options));
    },
    retrieve: (id: string): Promise<FakeIntent> => {
      stripeRecorder.record('paymentIntents.retrieve', [id]);
      return settle(() => {
        if (stripeRecorder.retrieveFailIntents.has(id)) {
          throw new FakeStripeError('StripeConnectionError', 'Network error retrieving intent', {
            statusCode: 500,
          });
        }
        return getIntent(id);
      });
    },
    capture: (
      id: string,
      params: Record<string, unknown>,
      options?: RequestOptions,
    ): Promise<FakeIntent> => {
      stripeRecorder.record('paymentIntents.capture', [id, params], options);
      return settle(() => {
        const intent = getIntent(id);
        if (stripeRecorder.captureFailIntents.has(id) || intent.status !== 'requires_capture') {
          throw new FakeStripeError(
            'StripeInvalidRequestError',
            `This PaymentIntent could not be captured because it has a status of ${intent.status === 'requires_capture' ? 'canceled' : intent.status}.`,
            { code: 'payment_intent_unexpected_state', statusCode: 400 },
          );
        }
        const amount = (params['amount_to_capture'] as number | undefined) ?? intent.amount;
        intent.status = 'succeeded';
        intent.amount_received = amount;
        intent.amount_capturable = 0;
        const fee = params['application_fee_amount'] as number | undefined;
        if (fee != null) intent.application_fee_amount = fee;
        return intent;
      });
    },
    cancel: (id: string, ...rest: unknown[]): Promise<FakeIntent> => {
      const [params, options] = rest as [Record<string, unknown> | undefined, RequestOptions?];
      const args: unknown[] = params === undefined ? [id] : [id, params];
      stripeRecorder.record('paymentIntents.cancel', args, options);
      return settle(() => {
        const intent = getIntent(id);
        if (intent.status === 'succeeded' || intent.status === 'canceled') {
          throw new FakeStripeError(
            'StripeInvalidRequestError',
            `You cannot cancel this PaymentIntent because it has a status of ${intent.status}.`,
            { code: 'payment_intent_unexpected_state', statusCode: 400 },
          );
        }
        intent.status = 'canceled';
        intent.amount_capturable = 0;
        return intent;
      });
    },
  };

  refunds = {
    create: (params: Record<string, unknown>, options?: RequestOptions): Promise<unknown> => {
      stripeRecorder.record('refunds.create', [params], options);
      return settle(() => {
        const intent = getIntent(params['payment_intent'] as string);
        const amount = (params['amount'] as number | undefined) ?? intent.amount_received;
        // Stripe refuses a refund above what the charge received.
        if (amount > intent.amount_received) {
          throw new FakeStripeError(
            'StripeInvalidRequestError',
            `Refund amount (${String(amount)}) is greater than charge amount (${String(intent.amount_received)})`,
            { code: 'amount_too_large', statusCode: 400 },
          );
        }
        return {
          id: options?.idempotencyKey != null ? `re_${options.idempotencyKey}` : 're_nokey',
          object: 'refund',
          amount,
          payment_intent: intent.id,
          status: 'succeeded',
        };
      });
    },
  };

  setupIntents = {
    create: (params: Record<string, unknown>, options?: RequestOptions): Promise<unknown> => {
      stripeRecorder.record('setupIntents.create', [params], options);
      return settle(() => {
        const customer = params['customer'] as string;
        if (stripeRecorder.staleCustomers.has(customer)) {
          throw new FakeStripeError(
            'StripeInvalidRequestError',
            `No such customer: '${customer}'`,
            { code: 'resource_missing', statusCode: 400 },
          );
        }
        const id = stripeRecorder.next('seti');
        return { id, object: 'setup_intent', client_secret: `${id}_secret_x`, customer };
      });
    },
  };

  customers = {
    create: (params: Record<string, unknown>, options?: RequestOptions): Promise<unknown> => {
      stripeRecorder.record('customers.create', [params], options);
      return Promise.resolve({ id: stripeRecorder.next('cus_new'), object: 'customer' });
    },
  };

  ephemeralKeys = {
    create: (params: Record<string, unknown>, options?: RequestOptions): Promise<unknown> => {
      stripeRecorder.record('ephemeralKeys.create', [params], options);
      return Promise.resolve({ id: 'ephkey_1', secret: 'ek_test_secret' });
    },
  };

  paymentMethods = {
    retrieve: (id: string): Promise<unknown> => {
      stripeRecorder.record('paymentMethods.retrieve', [id]);
      return settle(() => {
        const pm = stripeRecorder.paymentMethods.get(id);
        if (pm == null) {
          throw new FakeStripeError('StripeInvalidRequestError', `No such PaymentMethod: '${id}'`, {
            code: 'resource_missing',
            statusCode: 404,
          });
        }
        return { id: pm.id, object: 'payment_method', customer: pm.customer, card: pm.card };
      });
    },
    detach: (id: string): Promise<unknown> => {
      stripeRecorder.record('paymentMethods.detach', [id]);
      return Promise.resolve({ id, object: 'payment_method', customer: null });
    },
  };

  balance = {
    retrieve: (): Promise<unknown> => {
      stripeRecorder.record('balance.retrieve', []);
      return Promise.resolve({ object: 'balance', available: [], pending: [] });
    },
  };

  webhooks = {
    /** Accepts the signature `t=1,v1=<secret>`; not a network call, so not recorded. */
    constructEvent: (body: string, signature: string, secret: string): unknown => {
      if (signature !== `t=1,v1=${secret}`) {
        throw new FakeStripeError(
          'StripeSignatureVerificationError',
          'No signatures found matching the expected signature for payload',
          { statusCode: 400 },
        );
      }
      return JSON.parse(body) as unknown;
    },
  };
}

function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** The module object for `vi.mock('stripe', ...)`. */
export function fakeStripeModule(): { default: typeof FakeStripe } {
  return { default: FakeStripe };
}

/** Signature header the fake accepts for a webhook signed with `secret`. */
export function fakeStripeSignature(secret: string): string {
  return `t=1,v1=${secret}`;
}

// Generated ids (`ses_<12>`), also inside idempotency keys (`preauth_ses_<12>`).
const ID_PATTERN =
  /(?<![0-9a-z])(rol|usr|sit|sta|evs|con|ses|drv|dtk|rsv|cas|pgr|trf|flt|veh|inv)_[0-9a-z]{12}(?![0-9a-z])/g;
// Guest checkout session tokens (20 hex characters) in idempotency keys and intent ids.
const GUEST_TOKEN_PATTERN = /(?<=guest_preauth_|cancel_guest_)[0-9a-f]{20}(?![0-9a-z])/g;

/**
 * Replaces generated entity ids (`ses_<12>`, `drv_<12>`, ...) with stable
 * placeholders numbered in order of first appearance, plus any extra values
 * (guest session tokens, UUIDs) passed in `aliases`.
 */
/**
 * Object keys in sorted order, recursively: request parameters are a set
 * (Stripe form-encodes them), so their insertion order is not part of the record.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value != null && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

export function normalizeGolden(value: unknown, aliases: Record<string, string> = {}): unknown {
  let text = JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value)) as unknown), null, 2);
  for (const [raw, alias] of Object.entries(aliases)) {
    text = text.split(raw).join(alias);
  }
  const seen = new Map<string, string>();
  const counts = new Map<string, number>();
  text = text.replace(ID_PATTERN, (match: string, prefix: string) => {
    const known = seen.get(match);
    if (known != null) return known;
    const n = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, n);
    const alias = `<${prefix}:${String(n)}>`;
    seen.set(match, alias);
    return alias;
  });
  const tokens = new Map<string, string>();
  text = text.replace(GUEST_TOKEN_PATTERN, (match: string) => {
    const known = tokens.get(match);
    if (known != null) return known;
    const alias = `<guestToken:${String(tokens.size + 1)}>`;
    tokens.set(match, alias);
    return alias;
  });
  return JSON.parse(text) as unknown;
}

/** The golden file body: stable JSON with a trailing newline. */
export function goldenJson(value: unknown, aliases: Record<string, string> = {}): string {
  return `${JSON.stringify(normalizeGolden(value, aliases), null, 2)}\n`;
}
