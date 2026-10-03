// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  PaymentDeclinedError,
  PaymentMethodOwnershipError,
  PaymentValidationError,
  WebhookSignatureError,
} from '../../errors.js';
import type { PaymentProviderFactory } from '../../registry.js';
import type {
  AdjustHoldInput,
  AuthorizeHoldInput,
  CaptureInput,
  CaptureResult,
  ChargeResult,
  HoldResult,
  Idempotent,
  ImmediateChargeInput,
  MethodSetupSession,
  MethodSetupStep,
  ModificationResult,
  NormalizedPaymentEvent,
  PaymentProvider,
  PaymentProviderClientConfig,
  ProviderCapabilities,
  RefundInput,
  RefundResult,
  SavedMethodDetails,
  ShortfallInput,
  StartMethodSetupInput,
  WebhookAck,
} from '../../types.js';
import {
  customerId as newCustomerId,
  keyFraction,
  methodId as newMethodId,
  parseMethodId,
  parsePaymentId,
  paymentId as newPaymentId,
  prefixedId,
} from './ids.js';
import { findTestCard, SIMULATED_TEST_CARDS } from './test-cards.js';
import type { SimulatedScenario } from './test-cards.js';
import {
  isValidSimulatedSignature,
  parseSimulatedEvents,
  SIMULATED_SIGNATURE_HEADER,
  signSimulatedWebhook,
  simulatedWebhookKey,
} from './webhook-signing.js';

export const SIMULATED_PROVIDER_ID = 'simulated';

export type SimulatedResultMode = 'sync' | 'async';

/** A signed webhook body the provider wants delivered after a delay. */
export interface SimulatedWebhookDelivery {
  rawBody: string;
  headers: Record<string, string>;
  delaySeconds: number;
}

/**
 * Delivers simulated webhooks into the webhook pipeline. Per D-T2 the
 * production sink publishes on `csms_events` and the worker re-delivers after
 * a delayed BullMQ job into `ingestPaymentWebhook('simulated', ...)` (P10a).
 */
export interface SimulatedEventSink {
  deliver(delivery: SimulatedWebhookDelivery): Promise<void>;
}

export interface WarnLogger {
  warn(obj: object, msg: string): void;
}

export interface SimulatedProviderOptions {
  /** SETTINGS_ENCRYPTION_KEY; the webhook signing key is derived from it. */
  encryptionKey: string;
  /** 'sync' (Stripe-like, default) or 'async' (Adyen-like, needs `events`). */
  resultMode?: SimulatedResultMode;
  /** Failure rate of methods without a scenario (seeded data), 0 to 1. Default 0.2. */
  randomFailureRate?: number;
  /** Delay of async results. Default 3 s. */
  asyncDelaySeconds?: number;
  /** Delay of the dispute after a capture on the dispute card. Default 30 s. */
  disputeDelaySeconds?: number;
  events?: SimulatedEventSink | null;
  logger?: WarnLogger;
  /** [0, 1) per idempotency key for the random scenario. Default: derived from the key. */
  random?: (idempotencyKey: string) => number;
}

/** Test mode only: no network, no money. */
export class SimulatedPaymentProvider implements PaymentProvider {
  readonly id = SIMULATED_PROVIDER_ID;
  readonly webhookPath = 'payments/simulated';
  readonly capabilities: ProviderCapabilities;

  private readonly resultMode: SimulatedResultMode;
  private readonly randomFailureRate: number;
  private readonly asyncDelaySeconds: number;
  private readonly disputeDelaySeconds: number;
  private readonly events: SimulatedEventSink | null;
  private readonly logger: WarnLogger | null;
  private readonly random: (idempotencyKey: string) => number;
  private readonly encryptionKey: string;
  private readonly signingKey: Buffer;

  constructor(options: SimulatedProviderOptions) {
    this.resultMode = options.resultMode ?? 'sync';
    this.randomFailureRate = options.randomFailureRate ?? 0.2;
    this.asyncDelaySeconds = options.asyncDelaySeconds ?? 3;
    this.disputeDelaySeconds = options.disputeDelaySeconds ?? 30;
    this.events = options.events ?? null;
    this.logger = options.logger ?? null;
    this.random = options.random ?? keyFraction;
    this.encryptionKey = options.encryptionKey;
    if (!(this.randomFailureRate >= 0 && this.randomFailureRate <= 1)) {
      throw new Error('randomFailureRate must be between 0 and 1');
    }
    if (this.resultMode === 'async' && this.events == null) {
      throw new Error('The simulated provider in async mode needs an event sink');
    }
    this.signingKey = simulatedWebhookKey(options.encryptionKey);
    const async = this.resultMode === 'async';
    this.capabilities = {
      savedMethods: true,
      manualCapture: true,
      partialCapture: true,
      refunds: true,
      partialRefunds: true,
      webhooks: true,
      nativeMobileSheet: false,
      shortfall: async ? 'adjust_hold' : 'top_up',
      modificationResults: this.resultMode,
      clientActions: true,
      stateLookup: false,
      marketplaceSplit: 'none',
      currencies: 'all',
    };
  }

  clientConfig(): PaymentProviderClientConfig {
    return {
      provider: this.id,
      resultMode: this.resultMode,
      testCards: SIMULATED_TEST_CARDS.map(({ number, label, scenario }) => ({
        number,
        label,
        scenario,
      })),
    };
  }

  testConnection(): Promise<void> {
    return Promise.resolve();
  }

  createCustomer(
    input: { email: string; name: string } & Idempotent,
  ): Promise<{ customerId: string }> {
    return Promise.resolve({ customerId: newCustomerId(input.idempotencyKey) });
  }

  /** Simulated customers never go stale. */
  isUnknownCustomerError(): boolean {
    return false;
  }

  startMethodSetup(input: StartMethodSetupInput): Promise<MethodSetupSession> {
    return Promise.resolve({ ...this.clientConfig(), customerId: input.customerId });
  }

  /** payload is `{ testCard }`, a number from SIMULATED_TEST_CARDS; anything else is refused. */
  submitMethodSetup(
    input: { customerId: string; payload: unknown } & Idempotent,
  ): Promise<MethodSetupStep> {
    return settle((): MethodSetupStep => {
      this.assertCustomer(input.customerId);
      const card = findTestCard((input.payload as { testCard?: unknown } | null)?.testCard);
      if (card == null) throw new PaymentValidationError('Unknown test card');
      if (card.scenario === 'decline' || card.scenario === 'nofunds') {
        return { status: 'refused', reason: declineCode(card.scenario) };
      }
      const method: SavedMethodDetails = {
        methodId: newMethodId(card.scenario, card.number.slice(-4), input.idempotencyKey),
        customerId: input.customerId,
        brand: card.brand,
        last4: card.number.slice(-4),
      };
      if (card.scenario === 'action') {
        return {
          status: 'action_required',
          action: {
            provider: this.id,
            data: { challenge: 'method_setup', methodId: method.methodId },
          },
        };
      }
      return { status: 'saved', method };
    });
  }

  /** details is `{ methodId, outcome: 'approve' | 'fail' }` from the simulated challenge. */
  continueMethodSetup(
    input: { customerId: string; details: unknown } & Idempotent,
  ): Promise<MethodSetupStep> {
    return settle((): MethodSetupStep => {
      this.assertCustomer(input.customerId);
      const details = input.details as { methodId?: unknown; outcome?: unknown } | null;
      const id = typeof details?.methodId === 'string' ? details.methodId : '';
      const parsed = parseMethodId(id);
      if (parsed?.scenario !== 'action') {
        throw new PaymentValidationError('No simulated challenge for this method');
      }
      if (details?.outcome !== 'approve') {
        return { status: 'refused', reason: 'authentication_failed' };
      }
      return {
        status: 'saved',
        method: {
          methodId: id,
          customerId: input.customerId,
          brand: brandOf(parsed.last4),
          last4: parsed.last4,
        },
      };
    });
  }

  verifyMethod(input: { methodId: string; customerId: string }): Promise<SavedMethodDetails> {
    return settle(() => {
      const parsed = parseMethodId(input.methodId);
      if (parsed == null) throw new PaymentMethodOwnershipError();
      this.assertCustomer(input.customerId);
      return {
        methodId: input.methodId,
        customerId: input.customerId,
        brand: brandOf(parsed.last4),
        last4: parsed.last4,
      };
    });
  }

  detachMethod(): Promise<void> {
    return Promise.resolve();
  }

  authorizeHold(input: AuthorizeHoldInput): Promise<HoldResult> {
    return settle((): HoldResult => {
      const scenario = this.methodScenario(input);
      const key = input.idempotencyKey;
      if (scenario === 'action') {
        if (input.initiator === 'merchant') throw declined('authentication_required');
        const id = newPaymentId('action', input.amountCents, key);
        return {
          status: 'action_required',
          paymentId: id,
          action: { provider: this.id, data: { challenge: 'hold', paymentId: id } },
        };
      }
      this.throwChargeFailure(scenario, key);
      const authorizedCents =
        scenario === 'partial' ? Math.floor(input.amountCents / 2) : input.amountCents;
      return {
        status: 'authorized',
        paymentId: newPaymentId(scenario, authorizedCents, key),
        authorizedCents,
      };
    });
  }

  /** details is `{ outcome: 'approve' | 'fail' }` from the simulated challenge. */
  continueHold(
    input: { paymentId: string | null; details: unknown } & Idempotent,
  ): Promise<HoldResult> {
    return settle((): HoldResult => {
      const paymentId = input.paymentId;
      const parsed = paymentId == null ? null : parsePaymentId(paymentId);
      if (paymentId == null || parsed?.scenario !== 'action' || parsed.amountCents == null) {
        throw new PaymentValidationError('No simulated challenge for this payment');
      }
      if ((input.details as { outcome?: unknown } | null)?.outcome !== 'approve') {
        throw declined('authentication_failed');
      }
      return { status: 'authorized', paymentId, authorizedCents: parsed.amountCents };
    });
  }

  async adjustHold(
    input: AdjustHoldInput,
  ): Promise<ModificationResult<{ authorizedCents: number }>> {
    const success = this.scenarioOf(input.paymentId) !== 'adjfail';
    if (this.resultMode === 'sync') {
      if (!success) throw declined('adjustment_declined');
      return { state: 'succeeded', authorizedCents: input.newTotalCents };
    }
    return this.pending(input.idempotencyKey, (eventId, operationRef, occurredAt) => [
      {
        eventId,
        type: 'payment.adjusted',
        paymentId: input.paymentId,
        operationRef,
        occurredAt,
        authorizedCents: success ? input.newTotalCents : 0,
        success,
      },
    ]);
  }

  async capture(input: CaptureInput): Promise<ModificationResult<CaptureResult>> {
    const scenario = this.scenarioOf(input.paymentId);
    const key = input.idempotencyKey;
    const failed = scenario === 'capfail' || (scenario === 'random' && this.randomFails(key));
    if (this.resultMode === 'sync') {
      if (failed) throw declined('capture_failed');
      if (scenario === 'dispute') await this.emitDispute(input.paymentId, key);
      return { state: 'succeeded', capturedCents: input.amountCents, applicationFeeCents: 0 };
    }
    const result = await this.pending(key, (eventId, operationRef, occurredAt) =>
      failed
        ? [
            {
              eventId,
              type: 'payment.capture_failed',
              paymentId: input.paymentId,
              operationRef,
              occurredAt,
              reason: 'capture_failed',
            },
          ]
        : [
            {
              eventId,
              type: 'payment.captured',
              paymentId: input.paymentId,
              operationRef,
              occurredAt,
              amountCents: input.amountCents,
            },
          ],
    );
    if (!failed && scenario === 'dispute') await this.emitDispute(input.paymentId, key);
    return result;
  }

  chargeShortfall(input: ShortfallInput): Promise<ChargeResult> {
    return settle(() => {
      const amountCents = input.finalCostCents - input.capturedCents;
      if (amountCents <= 0) throw new Error('No shortfall to charge');
      const scenario = this.scenarioOf(input.originalPaymentId);
      this.throwOffSessionFailure(scenario, input.idempotencyKey);
      return {
        paymentId: newPaymentId(scenario, amountCents, input.idempotencyKey),
        amountCents,
        applicationFeeCents: 0,
      };
    });
  }

  chargeSavedMethod(input: ImmediateChargeInput): Promise<ChargeResult> {
    return settle(() => {
      const scenario = parseMethodId(input.methodId)?.scenario;
      if (scenario == null) throw new PaymentMethodOwnershipError();
      this.assertCustomer(input.customerId);
      this.throwOffSessionFailure(scenario, input.idempotencyKey);
      return {
        paymentId: newPaymentId(scenario, input.grossCents, input.idempotencyKey),
        amountCents: input.grossCents,
        applicationFeeCents: 0,
      };
    });
  }

  async cancelHold(
    input: { paymentId: string | null; merchantReference: string } & Idempotent,
  ): Promise<ModificationResult<object>> {
    const paymentId = input.paymentId;
    if (this.resultMode === 'sync' || paymentId == null) return { state: 'succeeded' };
    return this.pending(input.idempotencyKey, (eventId, operationRef, occurredAt) => [
      { eventId, type: 'payment.cancelled', paymentId, operationRef, occurredAt },
    ]);
  }

  async refund(input: RefundInput): Promise<ModificationResult<RefundResult>> {
    const amountCents = input.amountCents ?? parsePaymentId(input.paymentId)?.amountCents ?? null;
    if (amountCents == null) {
      throw new PaymentValidationError('A full refund of this payment needs amountCents');
    }
    const failed = this.scenarioOf(input.paymentId) === 'refundfail';
    const refundId = prefixedId('re', input.idempotencyKey);
    if (this.resultMode === 'sync') {
      if (failed) throw declined('refund_failed');
      return { state: 'succeeded', refundId, amountCents };
    }
    return this.pending(input.idempotencyKey, (eventId, operationRef, occurredAt) =>
      failed
        ? [
            {
              eventId,
              type: 'payment.refund_failed',
              paymentId: input.paymentId,
              operationRef,
              occurredAt,
              refundId,
              amountCents,
              reason: 'refund_failed',
            },
          ]
        : [
            {
              eventId,
              type: 'payment.refunded',
              paymentId: input.paymentId,
              operationRef,
              occurredAt,
              refundId,
              amountCents,
              cumulativeRefundedCents: null,
              capturedCents: null,
            },
          ],
    );
  }

  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): NormalizedPaymentEvent[] {
    const signature = headers[SIMULATED_SIGNATURE_HEADER];
    if (signature == null || signature === '') {
      throw new WebhookSignatureError('missing', `Missing ${SIMULATED_SIGNATURE_HEADER} header`);
    }
    if (!isValidSimulatedSignature(rawBody, signature, this.signingKey)) {
      throw new WebhookSignatureError('invalid', 'Invalid simulated webhook signature');
    }
    return parseSimulatedEvents(rawBody);
  }

  webhookAck(): WebhookAck {
    return { status: 200, contentType: 'application/json', body: '{"received":true}' };
  }

  private assertCustomer(customerId: string): void {
    if (!customerId.startsWith('cus_sim_')) throw new PaymentMethodOwnershipError();
  }

  private methodScenario(input: AuthorizeHoldInput): SimulatedScenario {
    if (input.method.kind === 'saved') {
      const parsed = parseMethodId(input.method.methodId);
      if (parsed == null || !input.method.customerId.startsWith('cus_sim_')) {
        throw new PaymentMethodOwnershipError();
      }
      return parsed.scenario;
    }
    const card = findTestCard((input.method.payload as { testCard?: unknown } | null)?.testCard);
    if (card == null) throw new PaymentValidationError('Unknown test card');
    return card.scenario;
  }

  private scenarioOf(paymentId: string): SimulatedScenario {
    const parsed = parsePaymentId(paymentId);
    if (parsed == null) throw new PaymentValidationError('Not a simulated payment id');
    return parsed.scenario;
  }

  private randomFails(key: string): boolean {
    return this.random(key) < this.randomFailureRate;
  }

  /** Declines at authorization or on any charge of the method. */
  private throwChargeFailure(scenario: SimulatedScenario, key: string): void {
    if (scenario === 'decline' || scenario === 'nofunds' || scenario === 'chargefail') {
      throw declined(declineCode(scenario));
    }
    if (scenario === 'random' && this.randomFails(key)) throw declined('simulated_failure');
  }

  /** As throwChargeFailure, plus authentication that cannot happen off session. */
  private throwOffSessionFailure(scenario: SimulatedScenario, key: string): void {
    if (scenario === 'action') throw declined('authentication_required');
    this.throwChargeFailure(scenario, key);
  }

  private async pending(
    key: string,
    build: (eventId: string, operationRef: string, occurredAt: Date) => NormalizedPaymentEvent[],
  ): Promise<{ state: 'pending'; operationRef: string }> {
    const operationRef = prefixedId('op', key);
    await this.emit(
      build(prefixedId('evt', key), operationRef, new Date()),
      this.asyncDelaySeconds,
    );
    return { state: 'pending', operationRef };
  }

  private async emitDispute(paymentId: string, key: string): Promise<void> {
    await this.emit(
      [
        {
          eventId: prefixedId('evt', `dispute:${key}`),
          type: 'payment.disputed',
          paymentId,
          disputeId: prefixedId('dp', key),
          reason: 'fraudulent',
          occurredAt: new Date(),
        },
      ],
      this.disputeDelaySeconds,
    );
  }

  /**
   * Hands signed events to the sink. A lost event is recoverable (the record
   * keeps its pending operation for reconciliation), so a failure is logged
   * and the call still succeeds (P9). Without a sink (sync mode) nothing is sent.
   */
  private async emit(events: NormalizedPaymentEvent[], delaySeconds: number): Promise<void> {
    if (this.events == null) return;
    const signed = signSimulatedWebhook(events, this.encryptionKey);
    try {
      await this.events.deliver({ ...signed, delaySeconds });
    } catch (err) {
      this.logger?.warn(
        { err, eventIds: events.map((e) => e.eventId) },
        'Simulated payment event not delivered',
      );
    }
  }
}

const DECLINE_MESSAGES: Record<string, string> = {
  card_declined: 'Your card was declined.',
  insufficient_funds: 'Your card has insufficient funds.',
  authentication_required: 'Your card requires authentication.',
  authentication_failed: 'Card authentication failed.',
  simulated_failure: 'Simulated payment failure.',
  capture_failed: 'Simulated capture failure.',
  adjustment_declined: 'Simulated authorization adjustment declined.',
  refund_failed: 'Simulated refund failure.',
};

/** Brand of the test card ending in last4; null for seeded methods without one. */
function brandOf(last4: string | null): string | null {
  if (last4 == null) return null;
  return SIMULATED_TEST_CARDS.find((c) => c.number.endsWith(last4))?.brand ?? null;
}

/** Runs a synchronous step and turns a throw into a rejected promise. */
function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

function declineCode(scenario: SimulatedScenario): string {
  return scenario === 'nofunds' ? 'insufficient_funds' : 'card_declined';
}

function declined(code: string): PaymentDeclinedError {
  return new PaymentDeclinedError(DECLINE_MESSAGES[code] ?? code, { code });
}

/** Always configured: it needs no credentials. Registered only where PAYMENTS_ALLOW_SIMULATED is true. */
export function simulatedProviderFactory(
  options: SimulatedProviderOptions,
): PaymentProviderFactory {
  const provider = new SimulatedPaymentProvider(options);
  return {
    id: SIMULATED_PROVIDER_ID,
    create: () => Promise.resolve(provider),
  };
}
