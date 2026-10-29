// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { IdtechTerminalProvider, IDTECH_LIVE_VERIFIED, mapIdtechTransaction } from '../index.js';
import { createFakeIdtech, type FakeIdtech } from '../testing/index.js';

function provider(fake: FakeIdtech): IdtechTerminalProvider {
  return new IdtechTerminalProvider({
    baseUrl: 'https://psg.test/api/v1/',
    merchantId: 'm_1',
    apiKey: 'key',
    apiSecret: 'secret',
    webhookSecret: 'whsec',
    fetch: fake.fetch,
  });
}

const START = {
  providerDeviceId: 'dev_6825',
  amountCents: 2500,
  currency: 'USD',
  reference: 'ptx_1',
  timeoutSeconds: 90,
  evseChoices: [] as number[],
  idempotencyKey: 'terminal_auth_ptx_1',
};

describe('ID TECH adapter (assumed contract)', () => {
  it('stays unverified until a live sandbox run passes', () => {
    expect(IDTECH_LIVE_VERIFIED).toBe(false);
  });

  it('sends Basic auth, the merchant, the idempotency key and the connector choices', async () => {
    const fake = createFakeIdtech();
    await provider(fake).startPayment({ ...START, evseChoices: [1, 2] });
    const req = fake.requests.at(-1)!;
    expect(req.path).toBe('/transactions/preauth');
    expect(req.headers['authorization']).toBe(
      `Basic ${Buffer.from('key:secret').toString('base64')}`,
    );
    expect(req.headers['x-merchant-id']).toBe('m_1');
    expect(req.headers['idempotency-key']).toBe('terminal_auth_ptx_1');
    expect(req.body).toMatchObject({ amount: 2500, currency: 'USD', connectorChoices: [1, 2] });
  });

  it('keeps only last 4, BIN 6 and the brand: a PAN-shaped field is dropped', async () => {
    const fake = createFakeIdtech({
      extraTransactionFields: { pan: '4761739001010119', track2: ';4761739001010119=2512?' },
    });
    const res = await provider(fake).startPayment(START);
    expect(res).toMatchObject({ cardLast4: '0119', cardBin: '476173', cardBrand: 'visa' });
    expect(JSON.stringify(res)).not.toContain('4761739001010119');
  });

  it('drops card fields that are not exactly 4 or 6 digits and a decline code holding a PAN', () => {
    const mapped = mapIdtechTransaction({
      transactionId: 't',
      status: 'DECLINED',
      card: { last4: '4761739001010119', bin: '47617390', brand: '<script>' },
      responseCode: 'card 4761739001010119 refused',
    });
    expect(mapped).toMatchObject({
      cardLast4: null,
      cardBin: null,
      cardBrand: null,
      declineCode: null,
    });
  });

  it('accepts only an https receipt URL', () => {
    const base = { transactionId: 't', status: 'CAPTURED' };
    expect(
      mapIdtechTransaction({ ...base, receiptUrl: 'javascript:alert(1)' }).receiptUrl,
    ).toBeNull();
    expect(mapIdtechTransaction({ ...base, receiptUrl: 'https://r.example/1' }).receiptUrl).toBe(
      'https://r.example/1',
    );
  });

  it('maps errors to kinds without reply text in the message', async () => {
    const fake = createFakeIdtech();
    const p = provider(fake);
    fake.failNext(429, undefined, { 'retry-after': '7200' });
    await expect(p.startPayment(START)).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterSeconds: 3600,
    });
    fake.failNext(409, 'DEVICE_OFFLINE');
    await expect(p.startPayment(START)).rejects.toMatchObject({ kind: 'device_offline' });
    fake.failNext(503);
    await expect(p.startPayment(START)).rejects.toMatchObject({
      kind: 'unavailable',
      retryable: true,
    });
    fake.failNext(401);
    await expect(p.startPayment(START)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('reports a failed test connection with the kind only', async () => {
    const fake = createFakeIdtech({ apiKey: 'other' });
    expect(await provider(fake).testConnection()).toEqual({ ok: false, reason: 'auth' });
    expect(await provider(createFakeIdtech()).testConnection()).toEqual({ ok: true });
  });

  it('reads the device SIM from the device report', async () => {
    const d = await provider(createFakeIdtech()).getDevice('dev_6825');
    expect(d).toMatchObject({ model: 'VP6825', online: true, iccid: '8901260000000000017' });
    const offline = await provider(createFakeIdtech()).getDevice('dev_7200');
    expect(offline).toMatchObject({ model: 'VP7200', online: false, iccid: null });
  });

  it('waits for the card and reads the authorized webhook', async () => {
    const fake = createFakeIdtech({ mode: 'wait' });
    const p = provider(fake);
    const held = await p.startPayment(START);
    expect(held.state).toBe('presenting');
    const { rawBody, signature } = fake.present(held.providerTxnRef, 'approve');
    const [event] = p.verifyWebhook(Buffer.from(rawBody), { 'x-psg-signature': signature });
    expect(event).toMatchObject({ kind: 'txn_state', reference: 'ptx_1' });
    expect(event?.txn?.state).toBe('authorized');
    expect((await p.getTransaction(held.providerTxnRef))?.state).toBe('authorized');
    expect(await p.getTransaction('missing')).toBeNull();
  });
});
