// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// An in-process fake of the ASSUMED ID TECH PSG contract (idtech/contract.ts),
// served through a fetch function, for unit tests. A mock server serves the
// same contract over HTTP for live checks.

import { IDTECH_HEADERS } from '../idtech/contract.js';
import { signWebhookBody } from '../webhook-signature.js';

export interface FakeIdtechTransaction {
  transactionId: string;
  deviceId: string;
  status: string;
  authorizedAmount: number | null;
  capturedAmount: number | null;
  refunded: number;
  currency: string;
  reference: string;
  connectorId: number | null;
}

export interface FakeIdtechOptions {
  apiKey?: string;
  apiSecret?: string;
  merchantId?: string;
  webhookSecret?: string;
  /** How a preauth answers: approve at once, decline, or wait for `present`. */
  mode?: 'approve' | 'decline' | 'wait';
  /** Extra reply fields on every transaction (tests put card data here to check the allow-list). */
  extraTransactionFields?: Record<string, unknown>;
}

export interface FakeIdtech {
  fetch: typeof fetch;
  transactions: Map<string, FakeIdtechTransaction>;
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
  /** The next reply of any route answers with this status (and code) once. */
  failNext(status: number, code?: string, headers?: Record<string, string>): void;
  /** The cardholder taps: approve or decline a waiting transaction; returns the signed webhook. */
  present(ref: string, outcome: 'approve' | 'decline'): { rawBody: string; signature: string };
  devices: Array<Record<string, unknown>>;
}

export function createFakeIdtech(options: FakeIdtechOptions = {}): FakeIdtech {
  const apiKey = options.apiKey ?? 'key';
  const apiSecret = options.apiSecret ?? 'secret';
  const merchantId = options.merchantId ?? 'm_1';
  const webhookSecret = options.webhookSecret ?? 'whsec';
  const expectedAuth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
  const transactions = new Map<string, FakeIdtechTransaction>();
  const byKey = new Map<string, string>();
  const requests: FakeIdtech['requests'] = [];
  const devices: Array<Record<string, unknown>> = [
    {
      deviceId: 'dev_6825',
      serialNumber: 'VP6825-0001',
      model: 'VP6825',
      firmwareVersion: '1.0',
      status: 'ONLINE',
      lastSeen: '2026-10-29T10:00:00Z',
      iccid: '8901260000000000017',
    },
    {
      deviceId: 'dev_7200',
      serialNumber: 'VP7200-0001',
      model: 'VP7200',
      firmwareVersion: '1.0',
      status: 'OFFLINE',
      lastSeen: '2026-10-29T09:00:00Z',
    },
  ];
  let failure: { status: number; code?: string; headers?: Record<string, string> } | null = null;
  let seq = 0;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const txnView = (t: FakeIdtechTransaction) => ({
    transactionId: t.transactionId,
    status: t.status,
    authorizedAmount: t.authorizedAmount,
    capturedAmount: t.capturedAmount,
    currency: t.currency,
    reference: t.reference,
    connectorId: t.connectorId,
    card:
      t.status === 'DECLINED' || t.status === 'PENDING_CARD'
        ? null
        : { last4: '0119', bin: '476173', brand: 'Visa' },
    responseCode: t.status === 'DECLINED' ? '05' : '00',
    receiptUrl: t.status === 'CAPTURED' ? `https://receipts.example/${t.transactionId}` : null,
    deviceId: t.deviceId,
    ...(options.extraTransactionFields ?? {}),
  });
  const approve = (t: FakeIdtechTransaction, amount: number): void => {
    t.status = 'AUTHORIZED';
    t.authorizedAmount = amount;
  };

  const route = (input: string | URL | Request, init?: RequestInit): Response => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^.*\/api\/v1/, '');
    requests.push({ method, path, headers, body });
    if (failure != null) {
      const f = failure;
      failure = null;
      return json(f.status, f.code != null ? { error: { code: f.code } } : {}, f.headers);
    }
    if (
      headers['authorization'] !== expectedAuth ||
      headers[IDTECH_HEADERS.merchant.toLowerCase()] !== merchantId
    ) {
      return json(401, { error: { code: 'UNAUTHORIZED' } });
    }
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === `/merchants/${merchantId}`) return json(200, { merchantId });
    if (method === 'GET' && path === '/devices') return json(200, { devices, nextCursor: null });
    if (method === 'GET' && (m = /^\/devices\/([^/]+)$/.exec(path)) != null) {
      const wanted = decodeURIComponent(m[1] ?? '');
      const d = devices.find((x) => x['deviceId'] === wanted);
      return d != null ? json(200, d) : json(404, {});
    }
    if (method === 'POST' && /^\/devices\/[^/]+\/display$/.test(path)) return json(202, {});
    if (method === 'POST' && path === '/transactions/preauth') {
      const key = headers[IDTECH_HEADERS.idempotency.toLowerCase()] ?? '';
      const existing = transactions.get(byKey.get(key) ?? '');
      if (existing != null) return json(200, txnView(existing));
      const b = body as {
        deviceId: string;
        amount: number;
        currency: string;
        reference: string;
        connectorChoices?: number[];
      };
      const d = devices.find((x) => x['deviceId'] === b.deviceId);
      if (d == null) return json(404, {});
      if (d['status'] !== 'ONLINE') return json(409, { error: { code: 'DEVICE_OFFLINE' } });
      seq += 1;
      const t: FakeIdtechTransaction = {
        transactionId: `psg_txn_${String(seq)}`,
        deviceId: b.deviceId,
        status: 'PENDING_CARD',
        authorizedAmount: null,
        capturedAmount: null,
        refunded: 0,
        currency: b.currency,
        reference: b.reference,
        connectorId: b.connectorChoices?.[0] ?? null,
      };
      if (options.mode === 'decline') t.status = 'DECLINED';
      else if (options.mode !== 'wait') approve(t, b.amount);
      transactions.set(t.transactionId, t);
      byKey.set(key, t.transactionId);
      return json(201, txnView(t));
    }
    if ((m = /^\/transactions\/([^/]+)(?:\/(capture|void|refund))?$/.exec(path)) != null) {
      const t = transactions.get(decodeURIComponent(m[1] ?? ''));
      if (t == null) return json(404, {});
      const op = m[2];
      if (op == null && method === 'GET') return json(200, txnView(t));
      const amount = (body as { amount?: number } | undefined)?.amount ?? 0;
      if (op === 'capture') {
        if (t.status === 'CAPTURED') return json(200, txnView(t));
        if (t.status !== 'AUTHORIZED') return json(409, { error: { code: 'INVALID_STATE' } });
        if (amount > (t.authorizedAmount ?? 0))
          return json(422, { error: { code: 'AMOUNT_ABOVE_AUTHORIZED' } });
        t.status = 'CAPTURED';
        t.capturedAmount = amount;
        return json(200, txnView(t));
      }
      if (op === 'void') {
        if (t.status === 'VOIDED') return json(200, txnView(t));
        if (t.status !== 'AUTHORIZED' && t.status !== 'PENDING_CARD')
          return json(409, { error: { code: 'INVALID_STATE' } });
        t.status = 'VOIDED';
        return json(200, txnView(t));
      }
      if (op === 'refund') {
        if (amount > (t.capturedAmount ?? 0) - t.refunded)
          return json(422, { error: { code: 'AMOUNT_ABOVE_AUTHORIZED' } });
        t.refunded += amount;
        t.status = t.refunded >= (t.capturedAmount ?? 0) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        return json(201, {
          refundId: `psg_rf_${t.transactionId}_${String(t.refunded)}`,
          status: 'SUCCEEDED',
        });
      }
    }
    return json(404, {});
  };
  const fakeFetch: typeof fetch = (input, init) => Promise.resolve(route(input, init));

  return {
    fetch: fakeFetch,
    transactions,
    requests,
    devices,
    failNext(status, code, headers) {
      failure = {
        status,
        ...(code != null ? { code } : {}),
        ...(headers != null ? { headers } : {}),
      };
    },
    present(ref, outcome) {
      const t = transactions.get(ref);
      if (t == null) throw new Error(`unknown transaction ${ref}`);
      if (outcome === 'approve') approve(t, 2500);
      else t.status = 'DECLINED';
      seq += 1;
      const rawBody = JSON.stringify({
        id: `evt_${String(seq)}`,
        type: 'transaction.updated',
        data: txnView(t),
      });
      return { rawBody, signature: signWebhookBody(webhookSecret, rawBody) };
    },
  };
}
