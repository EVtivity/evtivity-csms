// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PaymentTerminalRegistry,
  SimulatedTerminalProvider,
  simulatedWebhookSecret,
  TerminalProviderError,
  type TerminalProviderSettings,
} from '../index.js';
import { SIMULATED_SIGNATURE_HEADER } from '../simulated/provider.js';
import { signWebhookBody } from '../webhook-signature.js';

const KEY = 'k'.repeat(32);
const START = {
  providerDeviceId: 'sim_term_1',
  amountCents: 2500,
  currency: 'USD',
  reference: 'ptx_1',
  timeoutSeconds: 90,
  evseChoices: [] as number[],
  idempotencyKey: 'terminal_auth_ptx_1',
};

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'none';
  } catch (err) {
    return err instanceof TerminalProviderError ? err.kind : `other:${String(err)}`;
  }
}

describe('SimulatedTerminalProvider', () => {
  const sim = new SimulatedTerminalProvider({ encryptionKey: KEY });

  it('connects, lists its devices and reports an unknown one as null', async () => {
    expect(await sim.testConnection()).toEqual({ ok: true });
    const { devices, next } = await sim.listDevices();
    expect(next).toBeNull();
    expect(devices.map((d) => d.providerDeviceId)).toContain('sim_term_offline');
    expect(await sim.getDevice('nope')).toBeNull();
    expect((await sim.getDevice('sim_term_offline'))?.lastSeenAt).toBeNull();
    expect((await sim.getDevice('sim_term_1'))?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('refuses a start of a bad amount, an unknown or an offline device', async () => {
    expect(await kindOf(sim.startPayment({ ...START, amountCents: 0 }))).toBe('validation');
    expect(await kindOf(sim.startPayment({ ...START, providerDeviceId: 'x' }))).toBe('not_found');
    expect(await kindOf(sim.startPayment({ ...START, providerDeviceId: 'sim_term_offline' }))).toBe(
      'device_offline',
    );
  });

  it('authorizes the requested amount with a reference that carries it, and picks the first EVSE', async () => {
    const res = await sim.startPayment({ ...START, evseChoices: [3, 4] });
    expect(res).toMatchObject({ state: 'authorized', authorizedCents: 2500, evseId: 3 });
    expect(res.providerTxnRef).toMatch(/^ptx_sim_2500_[0-9a-f]{24}$/);
    const again = await sim.startPayment(START);
    expect(again.providerTxnRef).toBe(res.providerTxnRef);
  });

  it('declines on the decline device', async () => {
    const res = await sim.startPayment({ ...START, providerDeviceId: 'sim_term_decline' });
    expect(res).toMatchObject({ state: 'declined', declineCode: '05' });
  });

  it('stays presenting on the async device without an event sink', async () => {
    const res = await sim.startPayment({ ...START, providerDeviceId: 'sim_term_async' });
    expect(res.state).toBe('presenting');
  });

  it('keeps no transaction state', async () => {
    expect(await kindOf(sim.getTransaction())).toBe('unsupported');
  });

  it('captures and refunds at most the hold its reference carries', async () => {
    const { providerTxnRef: ref } = await sim.startPayment(START);
    expect(await kindOf(sim.capture(ref, 2501))).toBe('validation');
    expect(await kindOf(sim.capture(ref, 0))).toBe('validation');
    expect(await sim.capture(ref, 2500)).toMatchObject({ state: 'captured', capturedCents: 2500 });
    expect(await kindOf(sim.refund(ref, 2501, 'k'))).toBe('validation');
    expect(await sim.refund(ref, 100, 'k')).toMatchObject({ state: 'succeeded' });
    expect(await sim.void(ref)).toMatchObject({ state: 'voided', capturedCents: 0 });
    // An unknown reference throws before any promise exists; callers await inside try.
    expect(() => sim.void('ptx_other')).toThrow(/Unknown simulated transaction/);
    expect(() => sim.capture(`ptx_sim_0_${'a'.repeat(24)}`, 1)).toThrow(TerminalProviderError);
  });

  it('keeps the last 100 prompts', async () => {
    const screen = new SimulatedTerminalProvider({ encryptionKey: KEY });
    for (let i = 0; i < 105; i++) {
      await screen.displayMessage('sim_term_1', { kind: 'result', text: String(i) });
    }
    expect(screen.displayed).toHaveLength(100);
    expect(screen.displayed[0]?.message.text).toBe('5');
  });

  describe('verifyWebhook', () => {
    const secret = simulatedWebhookSecret(KEY);
    const now = new Date();
    function verify(body: unknown) {
      const raw = JSON.stringify(body);
      return sim.verifyWebhook(
        Buffer.from(raw),
        { [SIMULATED_SIGNATURE_HEADER]: signWebhookBody(secret, raw, now) },
        now,
      );
    }
    const event = {
      eventId: 'evt_1',
      kind: 'txn_state',
      providerDeviceId: 'sim_term_async',
      reference: 'ptx_1',
      txn: { providerTxnRef: 'ref', state: 'authorized', evseId: 2, currency: 'usd' },
    };

    it('reads a signed authorized or declined event', () => {
      expect(verify(event)[0]).toMatchObject({
        eventId: 'evt_1',
        reference: 'ptx_1',
        txn: { state: 'authorized', evseId: 2, currency: 'USD' },
      });
      expect(
        verify({ ...event, txn: { ...event.txn, state: 'declined', evseId: 0 } })[0]?.txn,
      ).toMatchObject({ state: 'declined', evseId: null });
    });

    it('refuses events that are not objects, without an id or a transaction state', () => {
      for (const body of [
        'text',
        null,
        { ...event, eventId: '' },
        { ...event, kind: 'refund' },
        { ...event, txn: undefined },
        { ...event, txn: { providerTxnRef: 'ref', state: 'captured' } },
        { ...event, txn: { state: 'authorized' } },
      ]) {
        expect(() => verify(body)).toThrow(TerminalProviderError);
      }
    });
  });

  it('sends the async authorization through its sink, signed', async () => {
    const sink = vi.fn(() => Promise.resolve());
    const asyncSim = new SimulatedTerminalProvider({ encryptionKey: KEY, eventSink: sink });
    await asyncSim.startPayment({ ...START, providerDeviceId: 'sim_term_async' });
    expect(sink).toHaveBeenCalledTimes(1);
    const [{ rawBody, signature }] = sink.mock.calls[0] as unknown as [
      { rawBody: string; signature: string },
    ];
    const events = asyncSim.verifyWebhook(Buffer.from(rawBody), {
      [SIMULATED_SIGNATURE_HEADER]: signature,
    });
    expect(events[0]?.txn?.state).toBe('authorized');
  });
});

const IDTECH: TerminalProviderSettings['idtech'] = {
  enabled: true,
  environment: 'sandbox',
  merchantId: 'm',
  apiKey: 'k',
  apiSecret: 's',
  webhookSecret: 'w',
};

describe('PaymentTerminalRegistry', () => {
  let server: Server;
  let baseUrl = '';
  const paths: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('answers unsupported for a provider that is not available and lists the available ones', async () => {
    const off = new PaymentTerminalRegistry({
      readSettings: () => Promise.resolve({ idtech: { ...IDTECH, enabled: false } }),
      encryptionKey: KEY,
      allowSimulated: false,
      allowUnverified: true,
    });
    expect(await kindOf(off.requireProvider('idtech'))).toBe('unsupported');
    expect(await off.availableProviders()).toEqual([]);
    const on = new PaymentTerminalRegistry({
      readSettings: () => Promise.resolve({ idtech: IDTECH }),
      encryptionKey: KEY,
      allowSimulated: true,
      allowUnverified: true,
    });
    expect(await on.availableProviders()).toEqual(['simulated', 'idtech']);
    expect((await on.requireProvider('simulated')).id).toBe('simulated');
  });

  it('sends ID TECH calls through the guarded fetch to the mock under its test path', async () => {
    const reg = new PaymentTerminalRegistry({
      readSettings: () => Promise.resolve({ idtech: IDTECH }),
      encryptionKey: KEY,
      allowSimulated: false,
      allowUnverified: true,
      testBaseUrl: baseUrl,
    });
    const idtech = await reg.requireProvider('idtech');
    expect(await idtech.testConnection()).toEqual({ ok: true });
    expect(paths).toContain('/idtech/api/v1/merchants/m');
  });
});
