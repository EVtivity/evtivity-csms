// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  IdtechTerminalProvider,
  SimulatedTerminalProvider,
  TerminalProviderError,
  SIMULATED_SIGNATURE_HEADER,
  simulatedWebhookSecret,
  signWebhookBody,
  type PaymentTerminalProvider,
} from '../index.js';
import { createFakeIdtech } from '../testing/index.js';

interface Harness {
  name: string;
  provider: PaymentTerminalProvider;
  deviceId: string;
  signedEvent: (ref: string) => { rawBody: Buffer; headers: Record<string, string> };
}

function simulatedHarness(): Harness {
  const provider = new SimulatedTerminalProvider({ encryptionKey: 'k'.repeat(32) });
  const secret = simulatedWebhookSecret('k'.repeat(32));
  return {
    name: 'simulated',
    provider,
    deviceId: 'sim_term_1',
    signedEvent: (ref) => {
      const raw = JSON.stringify({
        eventId: 'evt_1',
        kind: 'txn_state',
        providerDeviceId: 'sim_term_1',
        reference: 'ptx_1',
        txn: { providerTxnRef: ref, state: 'authorized', authorizedCents: 2500, cardLast4: '4242' },
      });
      return {
        rawBody: Buffer.from(raw),
        headers: { [SIMULATED_SIGNATURE_HEADER]: signWebhookBody(secret, raw) },
      };
    },
  };
}

function idtechHarness(): Harness {
  const fake = createFakeIdtech({ mode: 'approve' });
  const provider = new IdtechTerminalProvider({
    baseUrl: 'https://psg.test/api/v1',
    merchantId: 'm_1',
    apiKey: 'key',
    apiSecret: 'secret',
    webhookSecret: 'whsec',
    fetch: fake.fetch,
  });
  return {
    name: 'idtech',
    provider,
    deviceId: 'dev_6825',
    signedEvent: (ref) => {
      const { rawBody, signature } = fake.present(ref, 'approve');
      return { rawBody: Buffer.from(rawBody), headers: { 'x-psg-signature': signature } };
    },
  };
}

const START = {
  amountCents: 2500,
  currency: 'USD',
  reference: 'ptx_1',
  timeoutSeconds: 90,
  evseChoices: [] as number[],
};

describe.each([simulatedHarness, idtechHarness])('terminal provider contract (%#)', (make) => {
  it('authorizes, captures less than the hold, and refuses a capture above it', async () => {
    const { provider, deviceId } = make();
    const auth = await provider.startPayment({
      ...START,
      providerDeviceId: deviceId,
      idempotencyKey: 'terminal_auth_a',
    });
    expect(auth.state).toBe('authorized');
    expect(auth.authorizedCents).toBe(2500);
    expect(auth.cardLast4).toMatch(/^\d{4}$/);
    await expect(provider.capture(auth.providerTxnRef, 2501, 'k1')).rejects.toMatchObject({
      kind: 'validation',
    });
    const captured = await provider.capture(auth.providerTxnRef, 1800, 'terminal_capture_x');
    expect(captured.state).toBe('captured');
    expect(captured.capturedCents).toBe(1800);
  });

  it('replays the same answer for the same idempotency key', async () => {
    const { provider, deviceId } = make();
    const a = await provider.startPayment({
      ...START,
      providerDeviceId: deviceId,
      idempotencyKey: 'terminal_auth_same',
    });
    const b = await provider.startPayment({
      ...START,
      providerDeviceId: deviceId,
      idempotencyKey: 'terminal_auth_same',
    });
    expect(b.providerTxnRef).toBe(a.providerTxnRef);
  });

  it('voids a hold and refunds part of a capture', async () => {
    const { provider, deviceId } = make();
    const held = await provider.startPayment({
      ...START,
      providerDeviceId: deviceId,
      idempotencyKey: 'terminal_auth_v',
    });
    expect((await provider.void(held.providerTxnRef, 'terminal_void_v')).state).toBe('voided');
    const paid = await provider.startPayment({
      ...START,
      providerDeviceId: deviceId,
      idempotencyKey: 'terminal_auth_r',
    });
    await provider.capture(paid.providerTxnRef, 2000, 'terminal_capture_r');
    const refund = await provider.refund(paid.providerTxnRef, 500, 'terminal_refund_r_0_500');
    expect(refund.refundRef).not.toBe('');
  });

  it('refuses an amount outside 1 to 1,000,000 cents', async () => {
    const { provider, deviceId } = make();
    for (const amountCents of [0, 1_000_001, 1.5]) {
      await expect(
        provider.startPayment({
          ...START,
          amountCents,
          providerDeviceId: deviceId,
          idempotencyKey: `k_${String(amountCents)}`,
        }),
      ).rejects.toBeInstanceOf(TerminalProviderError);
    }
  });

  it('accepts a signed event and refuses a forged, replayed or tampered one', async () => {
    const h = make();
    const held = await h.provider.startPayment({
      ...START,
      providerDeviceId: h.deviceId,
      idempotencyKey: 'terminal_auth_w',
    });
    const { rawBody, headers } = h.signedEvent(held.providerTxnRef);
    const events = h.provider.verifyWebhook(rawBody, headers);
    expect(events).toHaveLength(1);
    expect(events[0]?.txn?.providerTxnRef).toBe(held.providerTxnRef);
    const tampered = Buffer.from(rawBody.toString().replace('authorized', 'captured'));
    expect(() => h.provider.verifyWebhook(tampered, headers)).toThrow(TerminalProviderError);
    expect(() => h.provider.verifyWebhook(rawBody, {})).toThrow(/missing/);
    const late = new Date(Date.now() + 10 * 60_000);
    expect(() => h.provider.verifyWebhook(rawBody, headers, late)).toThrow(/tolerance/);
  });

  it('lists devices and reports one', async () => {
    const { provider, deviceId } = make();
    const { devices } = await provider.listDevices();
    expect(devices.some((d) => d.providerDeviceId === deviceId)).toBe(true);
    expect((await provider.getDevice(deviceId))?.online).toBe(true);
    expect(await provider.getDevice('nope')).toBeNull();
  });
});

describe('simulated scenarios', () => {
  const provider = new SimulatedTerminalProvider({ encryptionKey: 'k'.repeat(32) });

  it('declines on the decline device and refuses the offline device', async () => {
    const declined = await provider.startPayment({
      ...START,
      providerDeviceId: 'sim_term_decline',
      idempotencyKey: 'd',
    });
    expect(declined.state).toBe('declined');
    await expect(
      provider.startPayment({
        ...START,
        providerDeviceId: 'sim_term_offline',
        idempotencyKey: 'o',
      }),
    ).rejects.toMatchObject({ kind: 'device_offline' });
  });

  it('the async device presents and sends a signed authorized event to the sink', async () => {
    const sent: Array<{ rawBody: string; signature: string }> = [];
    const asyncProvider = new SimulatedTerminalProvider({
      encryptionKey: 'k'.repeat(32),
      eventSink: (e) => {
        sent.push(e);
        return Promise.resolve();
      },
    });
    const res = await asyncProvider.startPayment({
      ...START,
      providerDeviceId: 'sim_term_async',
      idempotencyKey: 'a',
      evseChoices: [2, 1],
    });
    expect(res.state).toBe('presenting');
    expect(sent).toHaveLength(1);
    const events = asyncProvider.verifyWebhook(Buffer.from(sent[0]!.rawBody), {
      [SIMULATED_SIGNATURE_HEADER]: sent[0]!.signature,
    });
    expect(events[0]?.txn).toMatchObject({ state: 'authorized', authorizedCents: 2500, evseId: 2 });
  });

  it('keeps no state, so getTransaction is unsupported', async () => {
    await expect(provider.getTransaction()).rejects.toMatchObject({ kind: 'unsupported' });
  });
});
