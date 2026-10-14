// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The simulated EV's vehicle ids: Autocharge after the plug-in (2.1 typed
// token, 1.6 idTag with or without prefix) and the EVCCID in
// idToken.additionalInfo of a 2.1 transaction start (Q01.FR.02).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { liveHarness, silenceConsole } from './sim-harness.js';

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const MAC = '92D50A693F80';
const VIN = '5YJ3E1EA7KF317000';

describe('Autocharge plug-in', () => {
  it('2.1: authorizes the MacAddress and starts the transaction with it', async () => {
    const h = await liveHarness('ocpp2.1');
    const result = await h.sim.plugInEv(1, { evccid: MAC, autocharge: 'MacAddress' });
    expect(h.sent('Authorize').at(-1)).toEqual({ idToken: { idToken: MAC, type: 'MacAddress' } });
    expect(result).toMatchObject({ idToken: MAC, tokenType: 'MacAddress', status: 'Accepted' });
    expect(result?.transactionId).not.toBeNull();
    const started = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Started');
    // The token is the EVCCID itself: no additionalInfo.
    expect(started?.['idToken']).toEqual({ idToken: MAC, type: 'MacAddress' });
  });

  it('2.1: a refused vehicle id starts nothing', async () => {
    const h = await liveHarness('ocpp2.1', (action) =>
      action === 'Authorize' ? { idTokenInfo: { status: 'Invalid' } } : undefined,
    );
    const result = await h.sim.plugInEv(1, { vin: VIN, autocharge: 'VIN' });
    expect(result).toMatchObject({ idToken: VIN, tokenType: 'VIN', status: 'Invalid' });
    expect(result?.transactionId).toBeNull();
    expect(h.sent('TransactionEvent').filter((e) => e['eventType'] === 'Started')).toHaveLength(0);
  });

  it('2.1: a card start carries the EVCCID of the plugged-in EV in additionalInfo', async () => {
    const h = await liveHarness('ocpp2.1');
    expect(await h.sim.plugInEv(1, { evccid: MAC })).toBeNull();
    await h.sim.startCharging(1, 'CARD-1');
    const started = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Started');
    expect(started?.['idToken']).toEqual({
      idToken: 'CARD-1',
      type: 'ISO14443',
      additionalInfo: [{ additionalIdToken: MAC, type: 'EVCCID' }],
    });
  });

  it('2.1: the EV is forgotten at unplug', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugInEv(1, { evccid: MAC });
    await h.sim.unplug(1);
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'CARD-2');
    const started = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Started');
    expect(started?.['idToken']).toEqual({ idToken: 'CARD-2', type: 'ISO14443' });
  });

  it.each([
    [undefined, `VID:${MAC}`],
    ['', MAC],
    ['MAC:', `MAC:${MAC}`],
  ])('1.6: sends the idTag with prefix %s and starts the transaction', async (prefix, idTag) => {
    const h = await liveHarness('ocpp1.6');
    const result = await h.sim.plugInEv(1, {
      evccid: MAC,
      autocharge: 'MacAddress',
      ...(prefix != null ? { idTagPrefix: prefix } : {}),
    });
    expect(h.sent('Authorize').at(-1)).toEqual({ idTag });
    expect(result).toMatchObject({ idToken: idTag, tokenType: 'ISO14443', status: 'Accepted' });
    expect(h.sent('StartTransaction').at(-1)).toMatchObject({ idTag });
  });

  it('1.6: a VIN goes without a prefix', async () => {
    const h = await liveHarness('ocpp1.6');
    await h.sim.plugInEv(1, { vin: VIN, autocharge: 'VIN' });
    expect(h.sent('Authorize').at(-1)).toEqual({ idTag: VIN });
  });

  it('refuses Autocharge without the id it needs', async () => {
    const h = await liveHarness('ocpp2.1');
    await expect(h.sim.plugInEv(1, { autocharge: 'VIN' })).rejects.toThrow(/needs the EV's vin/);
  });
});
