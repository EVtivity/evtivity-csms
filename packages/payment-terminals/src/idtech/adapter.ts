// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { tryParseJson } from '@evtivity/lib/safe-json';
import {
  isTerminalAmount,
  TerminalProviderError,
  type PaymentTerminalProvider,
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
import { verifyWebhookSignature } from '../webhook-signature.js';
import { IdtechClient } from './client.js';
import {
  IDTECH_DEVICE_ONLINE,
  IDTECH_EVENT_TYPES,
  IDTECH_HEADERS,
  IDTECH_PATHS,
  IDTECH_TXN_STATES,
  IDTECH_VENDOR,
  type IdtechDevice,
  type IdtechPreauthBody,
  type IdtechTransaction,
} from './contract.js';

export interface IdtechProviderOptions {
  baseUrl: string;
  merchantId: string;
  apiKey: string;
  apiSecret: string;
  webhookSecret: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}

/** Assumed capabilities until the sandbox proves them (contract.ts). */
const CAPABILITIES: TerminalProviderCapabilities = Object.freeze({
  modes: Object.freeze(['cloud'] as const),
  incrementalAuthorization: false,
  partialCapture: true,
  refunds: 'full_and_partial',
  events: 'both',
  stateLookup: true,
  receipts: 'provider_url',
  deviceStatus: true,
  display: true,
});

function enc(value: string): string {
  return encodeURIComponent(value);
}

function fill(path: string, values: Record<string, string>): string {
  let out = path;
  for (const [name, value] of Object.entries(values)) out = out.replace(`{${name}}`, enc(value));
  return out;
}

/** A transaction reply through the allow-list: no field outside it is read or kept. */
export function mapIdtechTransaction(value: unknown): TerminalTxnResult {
  const txn = (typeof value === 'object' && value != null ? value : {}) as IdtechTransaction;
  const ref = cutString(txn.transactionId);
  const statusName = typeof txn.status === 'string' ? txn.status : '';
  const state = IDTECH_TXN_STATES[statusName];
  if (ref == null || state == null) {
    throw new TerminalProviderError(
      'unavailable',
      'ID TECH transaction reply has no reference or a state not in the contract',
    );
  }
  const card = typeof txn.card === 'object' && txn.card != null ? txn.card : {};
  const connector = txn.connectorId;
  const receipt = cutString(txn.receiptUrl);
  const receiptUrl = receipt != null && URL.parse(receipt)?.protocol === 'https:' ? receipt : null;
  return {
    providerTxnRef: ref,
    state,
    authorizedCents: centsField(txn.authorizedAmount),
    capturedCents: centsField(txn.capturedAmount),
    currency: cutString(txn.currency)?.toUpperCase().slice(0, 3) ?? null,
    cardLast4: cardLast4(card.last4),
    cardBin: cardBin(card.bin),
    cardBrand: cardBrand(card.brand),
    declineCode: safeText(txn.responseCode),
    receiptUrl,
    evseId:
      typeof connector === 'number' &&
      Number.isInteger(connector) &&
      connector > 0 &&
      connector < 1000
        ? connector
        : null,
  };
}

export function mapIdtechDevice(value: unknown): TerminalDevice | null {
  const d = (typeof value === 'object' && value != null ? value : {}) as IdtechDevice;
  const id = cutString(d.deviceId);
  if (id == null) return null;
  const lastSeen = typeof d.lastSeen === 'string' ? new Date(d.lastSeen) : null;
  const iccid = typeof d.iccid === 'string' && /^\d{18,22}$/.test(d.iccid) ? d.iccid : null;
  return {
    providerDeviceId: id,
    vendor: IDTECH_VENDOR,
    serialNumber: cutString(d.serialNumber),
    model: cutString(d.model),
    firmwareVersion: cutString(d.firmwareVersion),
    online: typeof d.status === 'string' ? (IDTECH_DEVICE_ONLINE[d.status] ?? null) : null,
    lastSeenAt: lastSeen != null && !Number.isNaN(lastSeen.getTime()) ? lastSeen : null,
    iccid,
  };
}

/**
 * The ID TECH PSG cloud adapter (VP6825 and VP7200 in cloud mode), against the
 * assumed contract of contract.ts. Off by default, and built only where the
 * contract is verified or under NODE_ENV development or test (registry).
 */
export class IdtechTerminalProvider implements PaymentTerminalProvider {
  readonly id = 'idtech' as const;
  readonly capabilities = CAPABILITIES;
  private readonly client: IdtechClient;
  private readonly merchantId: string;
  private readonly webhookSecret: string;

  constructor(options: IdtechProviderOptions) {
    this.client = new IdtechClient(options);
    this.merchantId = options.merchantId;
    this.webhookSecret = options.webhookSecret;
  }

  async testConnection(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.client.request({
        method: 'GET',
        path: fill(IDTECH_PATHS.ping, { merchant: this.merchantId }),
        label: IDTECH_PATHS.ping,
      });
      return { ok: true };
    } catch (err: unknown) {
      if (err instanceof TerminalProviderError) return { ok: false, reason: err.kind };
      throw err;
    }
  }

  async listDevices(cursor?: string): Promise<{ devices: TerminalDevice[]; next: string | null }> {
    const reply = (await this.client.request({
      method: 'GET',
      path: IDTECH_PATHS.devices,
      label: IDTECH_PATHS.devices,
      query: { cursor },
    })) as { devices?: unknown; nextCursor?: unknown };
    const list = Array.isArray(reply.devices) ? reply.devices.slice(0, 500) : [];
    const devices = list.map(mapIdtechDevice).filter((d): d is TerminalDevice => d != null);
    return { devices, next: cutString(reply.nextCursor) };
  }

  async getDevice(providerDeviceId: string): Promise<TerminalDevice | null> {
    try {
      return mapIdtechDevice(
        await this.client.request({
          method: 'GET',
          path: fill(IDTECH_PATHS.device, { id: providerDeviceId }),
          label: IDTECH_PATHS.device,
        }),
      );
    } catch (err: unknown) {
      if (err instanceof TerminalProviderError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  async startPayment(input: StartTerminalPaymentInput): Promise<TerminalTxnResult> {
    if (!isTerminalAmount(input.amountCents)) {
      throw new TerminalProviderError('validation', 'The amount must be 1 to 1,000,000 cents');
    }
    const body: IdtechPreauthBody = {
      deviceId: input.providerDeviceId,
      amount: input.amountCents,
      currency: input.currency,
      reference: input.reference,
      timeoutSeconds: input.timeoutSeconds,
      ...(input.evseChoices.length > 0 ? { connectorChoices: [...input.evseChoices] } : {}),
    };
    return mapIdtechTransaction(
      await this.client.request({
        method: 'POST',
        path: IDTECH_PATHS.preauth,
        label: IDTECH_PATHS.preauth,
        body,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }

  async getTransaction(providerTxnRef: string): Promise<TerminalTxnResult | null> {
    try {
      return mapIdtechTransaction(
        await this.client.request({
          method: 'GET',
          path: fill(IDTECH_PATHS.transaction, { ref: providerTxnRef }),
          label: IDTECH_PATHS.transaction,
        }),
      );
    } catch (err: unknown) {
      if (err instanceof TerminalProviderError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  async capture(
    providerTxnRef: string,
    amountCents: number,
    key: string,
  ): Promise<TerminalTxnResult> {
    if (!isTerminalAmount(amountCents)) {
      throw new TerminalProviderError('validation', 'The amount must be 1 to 1,000,000 cents');
    }
    const result = mapIdtechTransaction(
      await this.client.request({
        method: 'POST',
        path: fill(IDTECH_PATHS.capture, { ref: providerTxnRef }),
        label: IDTECH_PATHS.capture,
        body: { amount: amountCents },
        idempotencyKey: key,
      }),
    );
    // Layer 2 of "never capture more than authorized": a reply that says more
    // was captured than the hold, or than asked, is refused and logged by the caller.
    if (
      result.capturedCents != null &&
      (result.capturedCents > amountCents ||
        (result.authorizedCents != null && result.capturedCents > result.authorizedCents))
    ) {
      throw new TerminalProviderError(
        'validation',
        'ID TECH captured more than asked or authorized',
      );
    }
    return result;
  }

  async void(providerTxnRef: string, key: string): Promise<TerminalTxnResult> {
    return mapIdtechTransaction(
      await this.client.request({
        method: 'POST',
        path: fill(IDTECH_PATHS.void, { ref: providerTxnRef }),
        label: IDTECH_PATHS.void,
        body: {},
        idempotencyKey: key,
      }),
    );
  }

  async refund(
    providerTxnRef: string,
    amountCents: number,
    key: string,
  ): Promise<TerminalRefundResult> {
    if (!isTerminalAmount(amountCents)) {
      throw new TerminalProviderError('validation', 'The amount must be 1 to 1,000,000 cents');
    }
    const reply = (await this.client.request({
      method: 'POST',
      path: fill(IDTECH_PATHS.refund, { ref: providerTxnRef }),
      label: IDTECH_PATHS.refund,
      body: { amount: amountCents },
      idempotencyKey: key,
    })) as { refundId?: unknown; status?: unknown };
    const refundRef = cutString(reply.refundId);
    if (refundRef == null)
      throw new TerminalProviderError('unavailable', 'ID TECH refund reply has no id');
    return { refundRef, state: reply.status === 'SUCCEEDED' ? 'succeeded' : 'pending' };
  }

  async displayMessage(providerDeviceId: string, message: TerminalDisplayMessage): Promise<void> {
    await this.client.request({
      method: 'POST',
      path: fill(IDTECH_PATHS.display, { id: providerDeviceId }),
      label: IDTECH_PATHS.display,
      body: {
        kind: message.kind,
        text: message.text.slice(0, 200),
        ...(message.qrUrl != null ? { qrUrl: message.qrUrl } : {}),
      },
    });
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
    now: Date = new Date(),
  ): TerminalEvent[] {
    verifyWebhookSignature(this.webhookSecret, rawBody, headers[IDTECH_HEADERS.signature], now);
    const body = tryParseJson(rawBody.toString('utf8')) as {
      id?: unknown;
      type?: unknown;
      data?: unknown;
    } | null;
    const eventId = cutString(body?.id);
    if (body == null || eventId == null) {
      throw new TerminalProviderError('validation', 'The ID TECH event has no id');
    }
    const data = (typeof body.data === 'object' && body.data != null ? body.data : {}) as Record<
      string,
      unknown
    >;
    if (body.type === IDTECH_EVENT_TYPES.transaction) {
      const txn = mapIdtechTransaction(data);
      return [
        {
          eventId,
          kind: 'txn_state',
          providerTxnRef: txn.providerTxnRef,
          providerDeviceId: cutString(data['deviceId']),
          reference: cutString(data['reference']),
          txn,
        },
      ];
    }
    if (body.type === IDTECH_EVENT_TYPES.device) {
      const device = mapIdtechDevice(data);
      if (device == null) return [];
      return [
        {
          eventId,
          kind: 'device_status',
          providerTxnRef: null,
          providerDeviceId: device.providerDeviceId,
          reference: null,
          device: { online: device.online, lastSeenAt: device.lastSeenAt, iccid: device.iccid },
        },
      ];
    }
    if (body.type === IDTECH_EVENT_TYPES.refund) {
      const refundRef = cutString(data['refundId']);
      const amount = centsField(data['amount']);
      const status = data['status'];
      if (refundRef == null || amount == null || (status !== 'SUCCEEDED' && status !== 'FAILED'))
        return [];
      return [
        {
          eventId,
          kind: 'refund',
          providerTxnRef: cutString(data['transactionId']),
          providerDeviceId: null,
          reference: null,
          refund: {
            refundRef,
            amountCents: amount,
            state: status === 'SUCCEEDED' ? 'succeeded' : 'failed',
          },
        },
      ];
    }
    return [];
  }
}
