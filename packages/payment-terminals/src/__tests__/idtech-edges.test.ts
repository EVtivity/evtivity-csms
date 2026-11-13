// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Edges of the ID TECH adapter, its HTTP client and the shared reply helpers:
// every reply the adapter refuses, every error kind and the webhook shapes.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdtechTerminalProvider, mapIdtechTransaction, TerminalProviderError } from '../index.js';
import { mapIdtechDevice } from '../idtech/adapter.js';
import { idtechStatusKind } from '../idtech/contract.js';
import {
  centsField,
  cutString,
  MAX_RETRY_AFTER_SECONDS,
  readLimited,
  ReplyTooLargeError,
  retryAfterSeconds,
} from '../http.js';
import { signWebhookBody, verifyWebhookSignature } from '../webhook-signature.js';

type Reply = Response | Error;
const SECRET = 'whsec';

function stubFetch(...replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = replies.shift() ?? json({});
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function provider(fetchFn: typeof fetch): IdtechTerminalProvider {
  return new IdtechTerminalProvider({
    baseUrl: 'https://psg.test/api/v1//',
    merchantId: 'm 1',
    apiKey: 'key',
    apiSecret: 'secret',
    webhookSecret: SECRET,
    fetch: fetchFn,
  });
}

const TXN = { transactionId: 't_1', status: 'AUTHORIZED', authorizedAmount: 1000 };

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'none';
  } catch (err) {
    return err instanceof TerminalProviderError ? err.kind : `other:${String(err)}`;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('mapIdtechTransaction', () => {
  it('refuses a reply without a reference or with a state outside the contract', () => {
    expect(() => mapIdtechTransaction(null)).toThrow(TerminalProviderError);
    expect(() => mapIdtechTransaction({ transactionId: 't', status: 'SOMETHING' })).toThrow(
      /not in the contract/,
    );
    expect(() => mapIdtechTransaction({ status: 'AUTHORIZED' })).toThrow(TerminalProviderError);
  });

  it('reads only a connector in 1..999 and an upper-case 3-letter currency', () => {
    const base = { transactionId: 't', status: 'AUTHORIZED' };
    expect(mapIdtechTransaction({ ...base, connectorId: 2, currency: 'usdx' })).toMatchObject({
      evseId: 2,
      currency: 'USD',
    });
    for (const connectorId of [0, 1000, 1.5, '2']) {
      expect(mapIdtechTransaction({ ...base, connectorId }).evseId).toBeNull();
    }
    expect(mapIdtechTransaction({ ...base, card: 'x', authorizedAmount: -1 })).toMatchObject({
      cardLast4: null,
      authorizedCents: null,
      currency: null,
    });
  });
});

describe('mapIdtechDevice', () => {
  it('needs a device id and reads the status, date and ICCID only when valid', () => {
    expect(mapIdtechDevice(null)).toBeNull();
    expect(mapIdtechDevice({ deviceId: '  ' })).toBeNull();
    expect(
      mapIdtechDevice({
        deviceId: 'd',
        status: 'ONLINE',
        lastSeen: '2026-11-12T00:00:00Z',
        iccid: '8901260000000000017',
      }),
    ).toMatchObject({ online: true, iccid: '8901260000000000017' });
    expect(
      mapIdtechDevice({ deviceId: 'd', status: 'BROKEN', lastSeen: 'not a date', iccid: '12' }),
    ).toMatchObject({ online: null, lastSeenAt: null, iccid: null });
    expect(mapIdtechDevice({ deviceId: 'd', status: 3 })?.online).toBeNull();
  });
});

describe('IdtechTerminalProvider requests', () => {
  it('encodes ids in the path and sends the cursor only when given', async () => {
    const { fetchFn, calls } = stubFetch(
      json({}),
      json({ devices: [{ deviceId: 'a' }, { nothing: 1 }], nextCursor: 'c2' }),
      json({ devices: 'x' }),
    );
    const p = provider(fetchFn);
    expect(await p.testConnection()).toEqual({ ok: true });
    expect(calls[0]!.url).toBe('https://psg.test/api/v1/merchants/m%201');
    const page = await p.listDevices('c1');
    expect(page.devices.map((d) => d.providerDeviceId)).toEqual(['a']);
    expect(page.next).toBe('c2');
    expect(calls[1]!.url).toBe('https://psg.test/api/v1/devices?cursor=c1');
    expect(await p.listDevices()).toEqual({ devices: [], next: null });
    expect(calls[2]!.url).toBe('https://psg.test/api/v1/devices');
  });

  it('rethrows an error that is not a provider error from the test connection', async () => {
    const p = provider(stubFetch().fetchFn);
    const client = (p as unknown as { client: { request: () => Promise<unknown> } }).client;
    client.request = () => Promise.reject(new RangeError('bug'));
    await expect(p.testConnection()).rejects.toThrow(RangeError);
  });

  it('answers null for an unknown device or transaction and throws other errors', async () => {
    const { fetchFn } = stubFetch(json({}, 404), json({}, 500), json({}, 404), json({}, 401));
    const p = provider(fetchFn);
    expect(await p.getDevice('d/1')).toBeNull();
    expect(await kindOf(p.getDevice('d'))).toBe('unavailable');
    expect(await p.getTransaction('t')).toBeNull();
    expect(await kindOf(p.getTransaction('t'))).toBe('auth');
  });

  it('refuses amounts outside 1..1,000,000 cents before any request', async () => {
    const { fetchFn, calls } = stubFetch(json(TXN));
    const p = provider(fetchFn);
    const start = {
      providerDeviceId: 'd',
      currency: 'USD',
      reference: 'ptx',
      timeoutSeconds: 90,
      evseChoices: [],
      idempotencyKey: 'k',
    };
    expect(await kindOf(p.startPayment({ ...start, amountCents: 0 }))).toBe('validation');
    expect(await kindOf(p.capture('t', 1_000_001, 'k'))).toBe('validation');
    expect(await kindOf(p.refund('t', 0.5, 'k'))).toBe('validation');
    expect(calls).toHaveLength(0);
    await p.startPayment({ ...start, amountCents: 100 });
    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty('connectorChoices');
  });

  it('refuses a capture reply above the amount asked or the hold (layer 2)', async () => {
    const { fetchFn, calls } = stubFetch(
      json({ ...TXN, status: 'CAPTURED', capturedAmount: 600 }),
      json({ ...TXN, status: 'CAPTURED', capturedAmount: 1200, authorizedAmount: 1000 }),
      json({ ...TXN, status: 'CAPTURED', capturedAmount: 500 }),
    );
    const p = provider(fetchFn);
    expect(await kindOf(p.capture('t_1', 500, 'terminal_capture_t_1'))).toBe('validation');
    expect(await kindOf(p.capture('t_1', 1500, 'k'))).toBe('validation');
    expect((await p.capture('t_1', 500, 'k')).capturedCents).toBe(500);
    expect(calls[0]!.url).toBe('https://psg.test/api/v1/transactions/t_1/capture');
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe(
      'terminal_capture_t_1',
    );
  });

  it('voids with the key and maps a refund reply', async () => {
    const { fetchFn, calls } = stubFetch(
      json({ ...TXN, status: 'VOIDED' }),
      json({ refundId: 'r_1', status: 'SUCCEEDED' }),
      json({ refundId: 'r_2', status: 'PENDING' }),
      json({ status: 'SUCCEEDED' }),
    );
    const p = provider(fetchFn);
    expect((await p.void('t_1', 'vk')).state).toBe('voided');
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe('vk');
    expect(await p.refund('t_1', 100, 'rk')).toEqual({ refundRef: 'r_1', state: 'succeeded' });
    expect(await p.refund('t_1', 100, 'rk')).toEqual({ refundRef: 'r_2', state: 'pending' });
    expect(await kindOf(p.refund('t_1', 100, 'rk'))).toBe('unavailable');
  });

  it('cuts the display text and sends the QR link only when given', async () => {
    const { fetchFn, calls } = stubFetch();
    const p = provider(fetchFn);
    await p.displayMessage('d', { kind: 'result', text: 'x'.repeat(300) });
    await p.displayMessage('d', { kind: 'receipt', text: 'r', qrUrl: 'https://q.example' });
    const first = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect((first['text'] as string).length).toBe(200);
    expect(first).not.toHaveProperty('qrUrl');
    expect(JSON.parse(calls[1]!.init.body as string)).toMatchObject({ qrUrl: 'https://q.example' });
  });
});

describe('IdtechClient error mapping', () => {
  it('maps a network failure, an oversized and a cut-off reply to unavailable', async () => {
    const tooLarge = new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024) } });
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('reset'));
        },
      }),
    );
    const { fetchFn } = stubFetch(new TypeError('fetch failed'), tooLarge, broken);
    const p = provider(fetchFn);
    for (let i = 0; i < 3; i++) {
      const err = await p.getTransaction('t').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TerminalProviderError);
      expect((err as TerminalProviderError).kind).toBe('unavailable');
    }
  });

  it('takes the kind from a known error code, else from the status', async () => {
    const { fetchFn } = stubFetch(
      json({ error: { code: 'DEVICE_OFFLINE' } }, 409),
      json({ error: { code: 'UNKNOWN' } }, 402),
      new Response('not json', { status: 429 }),
      new Response('', { status: 200 }),
    );
    const p = provider(fetchFn);
    expect(await kindOf(p.void('t', 'k'))).toBe('device_offline');
    expect(await kindOf(p.void('t', 'k'))).toBe('declined');
    expect(await kindOf(p.void('t', 'k'))).toBe('rate_limited');
    expect(await kindOf(p.void('t', 'k'))).toBe('unavailable');
  });

  it('maps every status class', () => {
    expect(idtechStatusKind(403)).toBe('auth');
    expect(idtechStatusKind(404)).toBe('not_found');
    expect(idtechStatusKind(409)).toBe('device_busy');
    expect(idtechStatusKind(503)).toBe('unavailable');
    expect(idtechStatusKind(400)).toBe('validation');
  });
});

describe('IdtechTerminalProvider.verifyWebhook', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  function signed(body: unknown): [Buffer, Record<string, string>] {
    const raw = JSON.stringify(body);
    return [Buffer.from(raw), { 'x-psg-signature': signWebhookBody(SECRET, raw, now) }];
  }
  const p = provider(stubFetch().fetchFn);

  it('refuses an event without an id', () => {
    const [raw, headers] = signed({ type: 'transaction.updated' });
    expect(() => p.verifyWebhook(raw, headers, now)).toThrow(/no id/);
  });

  it('reads a transaction event with its device and reference', () => {
    const [raw, headers] = signed({
      id: 'ev_1',
      type: 'transaction.updated',
      data: { ...TXN, deviceId: 'd_1', reference: 'ptx_1' },
    });
    expect(p.verifyWebhook(raw, headers, now)).toEqual([
      expect.objectContaining({
        eventId: 'ev_1',
        kind: 'txn_state',
        providerTxnRef: 't_1',
        providerDeviceId: 'd_1',
        reference: 'ptx_1',
      }),
    ]);
  });

  it('reads a device event and drops one without a device id', () => {
    const [raw, headers] = signed({
      id: 'ev_2',
      type: 'device.status',
      data: { deviceId: 'd_1', status: 'OFFLINE' },
    });
    expect(p.verifyWebhook(raw, headers, now)[0]).toMatchObject({
      kind: 'device_status',
      providerDeviceId: 'd_1',
      device: { online: false },
    });
    const [raw2, headers2] = signed({ id: 'ev_3', type: 'device.status', data: 'x' });
    expect(p.verifyWebhook(raw2, headers2, now)).toEqual([]);
  });

  it('reads a settled refund and drops an incomplete one or another type', () => {
    const [raw, headers] = signed({
      id: 'ev_4',
      type: 'refund.updated',
      data: { refundId: 'r_1', amount: 300, status: 'FAILED', transactionId: 't_1' },
    });
    expect(p.verifyWebhook(raw, headers, now)[0]).toMatchObject({
      kind: 'refund',
      providerTxnRef: 't_1',
      refund: { refundRef: 'r_1', amountCents: 300, state: 'failed' },
    });
    for (const data of [
      { refundId: 'r', amount: 300, status: 'PENDING' },
      { refundId: 'r', amount: -1, status: 'SUCCEEDED' },
      { amount: 1, status: 'SUCCEEDED' },
    ]) {
      const [r, h] = signed({ id: 'ev_5', type: 'refund.updated', data });
      expect(p.verifyWebhook(r, h, now)).toEqual([]);
    }
    const [r, h] = signed({ id: 'ev_6', type: 'other' });
    expect(p.verifyWebhook(r, h, now)).toEqual([]);
  });
});

describe('verifyWebhookSignature', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const raw = '{"id":"x"}';
  const good = signWebhookBody(SECRET, raw, now);

  it('accepts a good signature and refuses a missing secret, a large body or a bad header', () => {
    expect(() => {
      verifyWebhookSignature(SECRET, Buffer.from(raw), good, now);
    }).not.toThrow();
    const kind = (fn: () => void): string => {
      try {
        fn();
        return 'none';
      } catch (err) {
        return (err as TerminalProviderError).kind;
      }
    };
    expect(kind(() => verifyWebhookSignature('', Buffer.from(raw), good, now))).toBe('auth');
    expect(
      kind(() => verifyWebhookSignature(SECRET, Buffer.alloc(256 * 1024 + 1), good, now)),
    ).toBe('validation');
    for (const header of [undefined, 'x'.repeat(1025), 'garbage', '=a,t=1', 't=abc,v1=zz']) {
      expect(kind(() => verifyWebhookSignature(SECRET, Buffer.from(raw), header, now))).toBe(
        'auth',
      );
    }
    const later = new Date(now.getTime() + 301_000);
    expect(kind(() => verifyWebhookSignature(SECRET, Buffer.from(raw), good, later))).toBe('auth');
    expect(kind(() => verifyWebhookSignature(SECRET, Buffer.from('{}'), good, now))).toBe('auth');
  });
});

describe('reply helpers', () => {
  it('reads Retry-After as seconds or a date, capped at an hour, else 60 s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
    expect(retryAfterSeconds(null)).toBe(60);
    expect(retryAfterSeconds('  ')).toBe(60);
    expect(retryAfterSeconds('2.2')).toBe(3);
    expect(retryAfterSeconds('99999')).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(retryAfterSeconds('Thu, 12 Nov 2026 12:02:00 GMT')).toBe(120);
    expect(retryAfterSeconds('Thu, 12 Nov 2026 11:00:00 GMT')).toBe(0);
    expect(retryAfterSeconds('soon')).toBe(60);
  });

  it('stops a reply over the limit, declared or streamed', async () => {
    await expect(
      readLimited(new Response('abc', { headers: { 'content-length': '10' } }), 5),
    ).rejects.toThrow(ReplyTooLargeError);
    await expect(readLimited(new Response('abcdefgh'), 5)).rejects.toThrow(ReplyTooLargeError);
    expect(await readLimited(new Response(null), 5)).toBe('');
    expect(await readLimited(new Response('abc'), 5)).toBe('abc');
  });

  it('cuts strings and reads cents only as whole numbers in range', () => {
    expect(cutString(5)).toBeNull();
    expect(cutString('  ')).toBeNull();
    expect(cutString(` ${'a'.repeat(300)} `)).toHaveLength(200);
    expect(centsField(1_000_000)).toBe(1_000_000);
    expect(centsField(1_000_001)).toBeNull();
    expect(centsField(1.5)).toBeNull();
    expect(centsField('5')).toBeNull();
  });
});
