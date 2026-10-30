// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash, hkdfSync } from 'node:crypto';
import { tryParseJson } from '@evtivity/lib/safe-json';
import {
  isTerminalAmount,
  TerminalProviderError,
  type PaymentTerminalProvider,
  type ProviderTxnState,
  type StartTerminalPaymentInput,
  type TerminalDevice,
  type TerminalDisplayMessage,
  type TerminalEvent,
  type TerminalProviderCapabilities,
  type TerminalRefundResult,
  type TerminalTxnResult,
} from '../types.js';
import { cardBin, cardBrand, cardLast4, safeText } from '../card-fields.js';
import { centsField, cutString } from '../http.js';
import { signWebhookBody, verifyWebhookSignature } from '../webhook-signature.js';

/** The signature header of simulated terminal events. */
export const SIMULATED_SIGNATURE_HEADER = 'x-evtivity-terminal-signature';

/** The vendor every simulated device reports (the simulated devices stand in for ID TECH terminals). */
export const SIMULATED_DEVICE_VENDOR = 'ID TECH';

/** The firmware version a simulated device of each model reports. */
export const SIMULATED_FIRMWARE_VERSIONS: Readonly<Record<'VP6825' | 'VP7200', string>> =
  Object.freeze({ VP6825: '1.01.106', VP7200: '1.00.042' });

/**
 * The simulated devices. `sim_term_1` to `sim_term_3` approve every card at
 * once; the scenario devices decline (`sim_term_decline`), are offline
 * (`sim_term_offline`), authorize later through a signed event
 * (`sim_term_async`) or report a SIM (`sim_term_lte`, the VP6825 LTE variant).
 * `sim_term_4` (VP6825) and `sim_term_5` (VP7200) are the terminals of the
 * demo seed, `sim_term_6` (VP6825) and `sim_term_7` (VP7200, offline) those of the
 * site layout demo, so no test or E2E run registers them. Each reports the vendor,
 * a serial number and a firmware version like an ID TECH device (fictional
 * values: the model digits and a sequence number, no real serial).
 */
export const SIMULATED_DEVICES: readonly TerminalDevice[] = Object.freeze([
  device('sim_term_1', 'VP6825', 1, null),
  device('sim_term_2', 'VP6825', 2, null),
  device('sim_term_3', 'VP7200', 3, null),
  device('sim_term_decline', 'VP6825', 11, null),
  device('sim_term_offline', 'VP6825', 12, null, false),
  device('sim_term_async', 'VP6825', 13, null),
  device('sim_term_lte', 'VP6825', 14, '8901260000000000017'),
  device('sim_term_4', 'VP6825', 4, null),
  device('sim_term_5', 'VP7200', 5, null),
  device('sim_term_6', 'VP6825', 6, null),
  device('sim_term_7', 'VP7200', 7, null, false),
]);

function device(
  id: string,
  model: 'VP6825' | 'VP7200',
  sequence: number,
  iccid: string | null,
  online = true,
): TerminalDevice {
  return {
    providerDeviceId: id,
    vendor: SIMULATED_DEVICE_VENDOR,
    serialNumber: `${model.slice(2)}SIM${String(sequence).padStart(6, '0')}`,
    model,
    firmwareVersion: SIMULATED_FIRMWARE_VERSIONS[model],
    online,
    lastSeenAt: online ? new Date(0) : null,
    iccid,
  };
}

/** Test card of the simulated provider (Visa 4242). */
export const SIMULATED_CARD = Object.freeze({ last4: '4242', bin: '424242', brand: 'visa' });

const CAPABILITIES: TerminalProviderCapabilities = Object.freeze({
  modes: Object.freeze(['cloud'] as const),
  incrementalAuthorization: false,
  partialCapture: true,
  refunds: 'full_and_partial',
  events: 'both',
  // Stateless across processes: a retry with the same key gets the same answer.
  stateLookup: false,
  receipts: 'none',
  deviceStatus: true,
  display: true,
});

/** Hands a signed event to the process that applies terminal webhooks (the worker queue). */
export type SimulatedTerminalEventSink = (event: {
  rawBody: string;
  signature: string;
}) => Promise<void>;

export interface SimulatedTerminalOptions {
  /** The key the event signing key is derived from (SETTINGS_ENCRYPTION_KEY). */
  encryptionKey: string;
  /** Where the async device sends its authorized event; without it the async device stays presenting. */
  eventSink?: SimulatedTerminalEventSink | null;
}

/** The HMAC key of simulated events, derived from the settings key (no stored secret). */
export function simulatedWebhookSecret(encryptionKey: string): string {
  return Buffer.from(
    hkdfSync('sha256', encryptionKey, 'evtivity', 'simulated-terminal-webhook', 32),
  ).toString('hex');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/**
 * A reference that carries the authorized amount, so a capture in any process
 * (no shared state) refuses more than the hold: `ptx_sim_<cents>_<hash of key>`.
 */
function txnRef(amountCents: number, key: string): string {
  return `ptx_sim_${String(amountCents)}_${hash(key)}`;
}

function authorizedOf(ref: string): number {
  const match = /^ptx_sim_(\d{1,7})_[0-9a-f]{24}$/.exec(ref);
  const cents = match != null ? Number(match[1]) : NaN;
  if (!isTerminalAmount(cents)) {
    throw new TerminalProviderError('not_found', 'Unknown simulated transaction reference');
  }
  return cents;
}

function result(
  ref: string,
  state: ProviderTxnState,
  overrides: Partial<TerminalTxnResult> = {},
): TerminalTxnResult {
  return {
    providerTxnRef: ref,
    state,
    authorizedCents: null,
    capturedCents: null,
    currency: null,
    cardLast4: null,
    cardBin: null,
    cardBrand: null,
    declineCode: null,
    receiptUrl: null,
    evseId: null,
    ...overrides,
  };
}

/**
 * The simulated terminal provider: no network, no money. Available only where
 * PAYMENT_TERMINALS_ALLOW_SIMULATED is true (development, test and demo data).
 */
export class SimulatedTerminalProvider implements PaymentTerminalProvider {
  readonly id = 'simulated' as const;
  readonly capabilities = CAPABILITIES;
  /** The prompts shown on the simulated screens, newest last (tests read them). */
  readonly displayed: Array<{ providerDeviceId: string; message: TerminalDisplayMessage }> = [];
  private readonly secret: string;
  private readonly eventSink: SimulatedTerminalEventSink | null;

  constructor(options: SimulatedTerminalOptions) {
    this.secret = simulatedWebhookSecret(options.encryptionKey);
    this.eventSink = options.eventSink ?? null;
  }

  testConnection(): Promise<{ ok: true }> {
    return Promise.resolve({ ok: true });
  }

  listDevices(): Promise<{ devices: TerminalDevice[]; next: string | null }> {
    return Promise.resolve({ devices: SIMULATED_DEVICES.map((d) => ({ ...d })), next: null });
  }

  getDevice(providerDeviceId: string): Promise<TerminalDevice | null> {
    const found = SIMULATED_DEVICES.find((d) => d.providerDeviceId === providerDeviceId);
    return Promise.resolve(
      found != null ? { ...found, lastSeenAt: found.online ? new Date() : null } : null,
    );
  }

  async startPayment(input: StartTerminalPaymentInput): Promise<TerminalTxnResult> {
    if (!isTerminalAmount(input.amountCents)) {
      throw new TerminalProviderError('validation', 'The amount must be 1 to 1,000,000 cents');
    }
    const found = SIMULATED_DEVICES.find((d) => d.providerDeviceId === input.providerDeviceId);
    if (found == null) throw new TerminalProviderError('not_found', 'Unknown simulated device');
    if (found.online !== true) {
      throw new TerminalProviderError('device_offline', 'The simulated device is offline');
    }
    const ref = txnRef(input.amountCents, input.idempotencyKey);
    if (found.providerDeviceId === 'sim_term_decline') {
      return result(ref, 'declined', { declineCode: '05', currency: input.currency });
    }
    const authorized = result(ref, 'authorized', {
      authorizedCents: input.amountCents,
      currency: input.currency,
      cardLast4: SIMULATED_CARD.last4,
      cardBin: SIMULATED_CARD.bin,
      cardBrand: SIMULATED_CARD.brand,
      // The simulated driver picks the first offered connector.
      evseId: input.evseChoices[0] ?? null,
    });
    if (found.providerDeviceId === 'sim_term_async') {
      if (this.eventSink != null) {
        const rawBody = JSON.stringify({
          eventId: `evt_sim_${hash(`${input.idempotencyKey}:authorized`)}`,
          kind: 'txn_state',
          providerDeviceId: input.providerDeviceId,
          reference: input.reference,
          txn: authorized,
        });
        await this.eventSink({ rawBody, signature: signWebhookBody(this.secret, rawBody) });
      }
      return result(ref, 'presenting', { currency: input.currency });
    }
    return authorized;
  }

  getTransaction(): Promise<TerminalTxnResult | null> {
    return Promise.reject(
      new TerminalProviderError('unsupported', 'The simulated provider keeps no transaction state'),
    );
  }

  capture(providerTxnRef: string, amountCents: number): Promise<TerminalTxnResult> {
    const authorizedCents = authorizedOf(providerTxnRef);
    if (!isTerminalAmount(amountCents) || amountCents > authorizedCents) {
      return Promise.reject(
        new TerminalProviderError('validation', 'The capture is above the authorized amount'),
      );
    }
    return Promise.resolve(
      result(providerTxnRef, 'captured', { authorizedCents, capturedCents: amountCents }),
    );
  }

  void(providerTxnRef: string): Promise<TerminalTxnResult> {
    const authorizedCents = authorizedOf(providerTxnRef);
    return Promise.resolve(result(providerTxnRef, 'voided', { authorizedCents, capturedCents: 0 }));
  }

  refund(providerTxnRef: string, amountCents: number, key: string): Promise<TerminalRefundResult> {
    const authorizedCents = authorizedOf(providerTxnRef);
    if (!isTerminalAmount(amountCents) || amountCents > authorizedCents) {
      return Promise.reject(
        new TerminalProviderError('validation', 'The refund is above the captured amount'),
      );
    }
    return Promise.resolve({ refundRef: `rf_sim_${hash(key)}`, state: 'succeeded' });
  }

  displayMessage(providerDeviceId: string, message: TerminalDisplayMessage): Promise<void> {
    this.displayed.push({ providerDeviceId, message });
    if (this.displayed.length > 100) this.displayed.shift();
    return Promise.resolve();
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
    now: Date = new Date(),
  ): TerminalEvent[] {
    verifyWebhookSignature(this.secret, rawBody, headers[SIMULATED_SIGNATURE_HEADER], now);
    const parsed = tryParseJson(rawBody.toString('utf8'));
    return parseSimulatedEvent(parsed);
  }
}

function parseSimulatedEvent(value: unknown): TerminalEvent[] {
  if (typeof value !== 'object' || value == null) {
    throw new TerminalProviderError('validation', 'The event is not an object');
  }
  const body = value as Record<string, unknown>;
  const eventId = cutString(body['eventId']);
  if (eventId == null || body['kind'] !== 'txn_state') {
    throw new TerminalProviderError('validation', 'The event has no id or an unknown kind');
  }
  const txn = body['txn'] as Record<string, unknown> | undefined;
  const ref = cutString(txn?.['providerTxnRef']);
  const state = txn?.['state'];
  if (txn == null || ref == null || (state !== 'authorized' && state !== 'declined')) {
    throw new TerminalProviderError('validation', 'The event has no transaction state');
  }
  const evse = txn['evseId'];
  return [
    {
      eventId,
      kind: 'txn_state',
      providerTxnRef: ref,
      providerDeviceId: cutString(body['providerDeviceId']),
      reference: cutString(body['reference']),
      txn: result(ref, state, {
        authorizedCents: centsField(txn['authorizedCents']),
        currency: cutString(txn['currency'])?.toUpperCase() ?? null,
        cardLast4: cardLast4(txn['cardLast4']),
        cardBin: cardBin(txn['cardBin']),
        cardBrand: cardBrand(txn['cardBrand']),
        declineCode: safeText(txn['declineCode']),
        evseId: typeof evse === 'number' && Number.isInteger(evse) && evse > 0 ? evse : null,
      }),
    },
  ];
}
